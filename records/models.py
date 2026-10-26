import os
import re
import secrets
import uuid
from datetime import timedelta

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import FileExtensionValidator, MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone

from appointments.models import Appointment

ALLOWED_EXTENSIONS = ["pdf", "jpg", "jpeg", "png"]
PRESCRIPTION_VALIDITY = timedelta(days=90)


class MedicalRecord(models.Model):
    """The patient's health file: one per patient, created on first use."""

    class BloodType(models.TextChoices):
        A_POS = "A+", "A+"
        A_NEG = "A-", "A−"
        B_POS = "B+", "B+"
        B_NEG = "B-", "B−"
        AB_POS = "AB+", "AB+"
        AB_NEG = "AB-", "AB−"
        O_POS = "O+", "O+"
        O_NEG = "O-", "O−"

    patient = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="medical_record", verbose_name="patient"
    )
    blood_type = models.CharField("groupe sanguin", max_length=3, choices=BloodType.choices, blank=True)
    height_cm = models.PositiveSmallIntegerField(
        "taille (cm)", null=True, blank=True, validators=[MinValueValidator(40), MaxValueValidator(250)]
    )
    weight_kg = models.DecimalField(
        "poids (kg)", max_digits=4, decimal_places=1, null=True, blank=True,
        validators=[MinValueValidator(2), MaxValueValidator(400)],
    )
    allergies = models.TextField("allergies", blank=True)
    chronic_conditions = models.TextField("maladies chroniques", blank=True)
    current_treatments = models.TextField("traitements en cours", blank=True)
    medical_history = models.TextField("antécédents médicaux et chirurgicaux", blank=True)
    family_history = models.TextField("antécédents familiaux", blank=True)
    emergency_contact = models.CharField("personne à prévenir", max_length=150, blank=True)
    created_at = models.DateTimeField("créé le", auto_now_add=True)
    updated_at = models.DateTimeField("mis à jour le", auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+", verbose_name="mis à jour par",
    )

    class Meta:
        verbose_name = "dossier médical"
        verbose_name_plural = "dossiers médicaux"

    def __str__(self):
        return f"Dossier de {self.patient.get_full_name() or self.patient.email}"

    @classmethod
    def for_patient(cls, patient):
        record, _ = cls.objects.get_or_create(patient=patient)
        return record

    @property
    def bmi(self):
        if not self.height_cm or not self.weight_kg:
            return None
        meters = self.height_cm / 100
        return round(float(self.weight_kg) / (meters * meters), 1)

    @property
    def is_empty(self):
        return not any([
            self.blood_type, self.height_cm, self.weight_kg, self.allergies, self.chronic_conditions,
            self.current_treatments, self.medical_history, self.family_history,
        ])


class ConsultationNote(models.Model):
    """Clinical note written by a doctor in the patient's record."""

    record = models.ForeignKey(MedicalRecord, on_delete=models.CASCADE, related_name="notes", verbose_name="dossier")
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="written_notes",
        verbose_name="médecin",
    )
    appointment = models.ForeignKey(
        Appointment, on_delete=models.SET_NULL, null=True, blank=True, related_name="notes",
        verbose_name="consultation liée",
    )
    title = models.CharField("titre", max_length=150)
    body = models.TextField("note")
    visible_to_patient = models.BooleanField(
        "visible par le patient", default=True,
        help_text="Décochez pour une note de travail réservée aux médecins qui suivent le patient.",
    )
    created_at = models.DateTimeField("rédigée le", auto_now_add=True)

    class Meta:
        verbose_name = "note de consultation"
        verbose_name_plural = "notes de consultation"
        ordering = ["-created_at"]

    def __str__(self):
        return self.title


class Drug(models.Model):
    """Drug catalogue used to write prescriptions."""

    class Form(models.TextChoices):
        TABLET = "tablet", "Comprimé"
        CAPSULE = "capsule", "Gélule"
        SYRUP = "syrup", "Sirop"
        SACHET = "sachet", "Sachet"
        DROPS = "drops", "Gouttes"
        SPRAY = "spray", "Spray"
        INHALER = "inhaler", "Inhalateur"
        CREAM = "cream", "Crème / pommade"
        INJECTION = "injection", "Injectable"
        SUPPOSITORY = "suppository", "Suppositoire"
        OTHER = "other", "Autre"

    name = models.CharField("nom", max_length=120)
    dci = models.CharField("principe actif (DCI)", max_length=120, blank=True)
    drug_class = models.CharField(
        "classe", max_length=80, blank=True,
        help_text="Famille de médicaments (ex. : pénicillines, AINS), utilisée pour vérifier les allergies.",
    )
    form = models.CharField("forme", max_length=12, choices=Form.choices, default=Form.TABLET)
    strength = models.CharField("dosage", max_length=50, blank=True)
    is_active = models.BooleanField("disponible", default=True)

    class Meta:
        verbose_name = "médicament"
        verbose_name_plural = "médicaments"
        ordering = ["name", "strength"]
        constraints = [models.UniqueConstraint(fields=["name", "form", "strength"], name="unique_drug")]

    def __str__(self):
        label = f"{self.name} {self.strength}".strip()
        return f"{label} · {self.get_form_display().lower()}"

    @property
    def label(self):
        """What the doctor types / sees in the suggestions, e.g. "Paracétamol 1 g"."""
        return f"{self.name} {self.strength}".strip()

    def allergy_terms(self):
        """Words to look for in the patient's allergies (name, each active ingredient, class)."""
        parts = re.split(r"[,/]", f"{self.name},{self.dci},{self.drug_class}")
        return {p.strip().lower() for p in parts if len(p.strip()) > 2}


def _prescription_code():
    return f"ORD-{secrets.token_hex(4).upper()}"


def _default_valid_until():
    return timezone.localdate() + PRESCRIPTION_VALIDITY


class Prescription(models.Model):
    record = models.ForeignKey(
        MedicalRecord, on_delete=models.CASCADE, related_name="prescriptions", verbose_name="dossier"
    )
    doctor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="written_prescriptions",
        verbose_name="médecin",
    )
    appointment = models.ForeignKey(
        Appointment, on_delete=models.SET_NULL, null=True, blank=True, related_name="prescriptions",
        verbose_name="consultation liée",
    )
    code = models.CharField("référence", max_length=16, unique=True, default=_prescription_code, editable=False)
    notes = models.TextField("recommandations", blank=True)
    valid_until = models.DateField("valable jusqu'au", default=_default_valid_until)
    created_at = models.DateTimeField("rédigée le", auto_now_add=True)

    class Meta:
        verbose_name = "ordonnance"
        verbose_name_plural = "ordonnances"
        ordering = ["-created_at"]

    def __str__(self):
        return f"Ordonnance {self.code}"

    @property
    def patient(self):
        return self.record.patient

    @property
    def is_valid(self):
        return self.valid_until >= timezone.localdate()

    @property
    def title(self):
        names = [item.drug_name for item in self.items.all()]
        if not names:
            return "Ordonnance"
        return names[0] + (f" + {len(names) - 1}" if len(names) > 1 else "")


class PrescriptionItem(models.Model):
    prescription = models.ForeignKey(
        Prescription, on_delete=models.CASCADE, related_name="items", verbose_name="ordonnance"
    )
    # Typed by the doctor. Linked to the catalogue when the name matches one of its entries
    # (used for the allergy check), but any drug can be prescribed.
    drug_name = models.CharField("médicament", max_length=150)
    drug = models.ForeignKey(
        Drug, on_delete=models.SET_NULL, null=True, blank=True, related_name="+", verbose_name="fiche du catalogue"
    )
    dosage = models.CharField("posologie", max_length=80)
    frequency = models.CharField("fréquence", max_length=80)
    duration = models.CharField("durée", max_length=60)
    instructions = models.CharField("précisions", max_length=200, blank=True)

    class Meta:
        verbose_name = "ligne d'ordonnance"
        verbose_name_plural = "lignes d'ordonnance"
        ordering = ["id"]

    def __str__(self):
        return f"{self.drug_name} — {self.dosage}, {self.frequency}, {self.duration}"


def _document_path(instance, filename):
    ext = os.path.splitext(filename)[1].lower()
    return f"dossiers/{instance.record.patient_id}/{uuid.uuid4().hex}{ext}"


def validate_document_size(file):
    if file.size > settings.MAX_UPLOAD_SIZE:
        raise ValidationError("Le fichier dépasse 5 Mo.")


class MedicalDocument(models.Model):
    """Lab results, imaging, letters… added by the patient or a doctor."""

    class Kind(models.TextChoices):
        ANALYSIS = "analysis", "Analyse biologique"
        IMAGING = "imaging", "Imagerie"
        REPORT = "report", "Compte rendu / courrier"
        PRESCRIPTION = "prescription", "Ordonnance externe"
        VACCINATION = "vaccination", "Vaccination"
        OTHER = "other", "Autre"

    ICONS = {
        "analysis": "droplet", "imaging": "radioactive", "report": "file-earmark-text",
        "prescription": "prescription2", "vaccination": "shield-plus", "other": "file-earmark",
    }

    record = models.ForeignKey(MedicalRecord, on_delete=models.CASCADE, related_name="documents", verbose_name="dossier")
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="+", verbose_name="ajouté par"
    )
    kind = models.CharField("type", max_length=12, choices=Kind.choices, default=Kind.ANALYSIS)
    title = models.CharField("titre", max_length=150)
    document_date = models.DateField("date du document", null=True, blank=True)
    file = models.FileField(
        "fichier", upload_to=_document_path,
        validators=[FileExtensionValidator(ALLOWED_EXTENSIONS), validate_document_size],
    )
    original_name = models.CharField(max_length=200, blank=True, editable=False)
    size = models.PositiveIntegerField(default=0, editable=False)
    created_at = models.DateTimeField("ajouté le", auto_now_add=True)

    class Meta:
        verbose_name = "document médical"
        verbose_name_plural = "documents médicaux"
        ordering = ["-created_at"]

    def __str__(self):
        return self.title

    @property
    def icon(self):
        return self.ICONS.get(self.kind, "file-earmark")

    @property
    def extension(self):
        return os.path.splitext(self.file.name)[1].lstrip(".").upper()

    @property
    def size_label(self):
        if self.size >= 1024 * 1024:
            return f"{self.size / 1024 / 1024:.1f} Mo"
        return f"{max(1, self.size // 1024)} Ko"


class AccessLog(models.Model):
    """Who opened or changed a medical record, and when (shown to the patient)."""

    class Action(models.TextChoices):
        VIEW = "view", "Consultation du dossier"
        UPDATE = "update", "Mise à jour des informations médicales"
        NOTE = "note", "Ajout d'une note"
        PRESCRIPTION = "prescription", "Rédaction d'une ordonnance"
        PRESCRIPTION_VIEW = "prescription_view", "Consultation d'une ordonnance"
        DOCUMENT_ADD = "document_add", "Ajout d'un document"
        DOCUMENT_VIEW = "document_view", "Ouverture d'un document"
        DOCUMENT_DELETE = "document_delete", "Suppression d'un document"

    ICONS = {
        "view": "eye", "update": "pencil", "note": "journal-text", "prescription": "prescription2",
        "prescription_view": "prescription2", "document_add": "file-earmark-plus",
        "document_view": "file-earmark", "document_delete": "trash",
    }

    record = models.ForeignKey(
        MedicalRecord, on_delete=models.CASCADE, related_name="access_logs", verbose_name="dossier"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="+", verbose_name="utilisateur"
    )
    action = models.CharField("action", max_length=20, choices=Action.choices)
    detail = models.CharField("détail", max_length=200, blank=True)
    ip_address = models.GenericIPAddressField("adresse IP", null=True, blank=True)
    created_at = models.DateTimeField("date", auto_now_add=True)

    class Meta:
        verbose_name = "journal d'accès"
        verbose_name_plural = "journal des accès"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["record", "-created_at"])]

    def __str__(self):
        return f"{self.get_action_display()} · {self.created_at:%d/%m/%Y %H:%M}"

    @property
    def icon(self):
        return self.ICONS.get(self.action, "dot")
