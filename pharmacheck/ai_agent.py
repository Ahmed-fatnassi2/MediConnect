"""Optional, doctor-only second opinion that cannot lower the rules severity."""

import json
import logging
import re
import threading
from typing import Literal

from django.conf import settings
from django.db import close_old_connections, connection
from django.utils import timezone
from pydantic import BaseModel, Field, field_validator

from records.ai_analysis import patient_context
from records.models import PrescriptionCheck

from .engine import SEVERITY_ORDER

logger = logging.getLogger("records")
_DOSE = re.compile(
    r"\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|ug|g|ml|ui|iu|milligrammes?|microgrammes?|grammes?)\b",
    re.IGNORECASE,
)


class PharmacheckOpinion(BaseModel):
    overall_level: Literal["info", "minor", "moderate", "major", "contraindicated"] = Field(
        description="Niveau global de risque proposé, sans jamais minimiser une alerte des règles."
    )
    additional_concerns: list[str] = Field(description="Préoccupations supplémentaires à discuter.")
    alternatives: list[str] = Field(description="Pistes thérapeutiques non posologiques à discuter avec le médecin.")
    comment: str = Field(description="Commentaire bref en français, à visée de soutien à la décision.")

    @field_validator("additional_concerns", "alternatives")
    @classmethod
    def reject_doses(cls, values):
        if any(_DOSE.search(value) for value in values):
            raise ValueError("L'avis ne doit proposer ni recopier de dose.")
        return values

    @field_validator("comment")
    @classmethod
    def reject_dose_in_comment(cls, value):
        if _DOSE.search(value):
            raise ValueError("L'avis ne doit proposer ni recopier de dose.")
        return value


SYSTEM_PROMPT = """Tu es un outil de seconde lecture pour le médecin prescripteur de MediConnect.
Tu aides à examiner une ordonnance avec les résultats déterministes et le contexte clinique fournis par les outils.
Appelle obligatoirement `resultats_regles` et `contexte_patient`.
Ne pose aucun diagnostic et ne remplace jamais le jugement clinique du médecin.
Tu peux signaler des préoccupations ou pistes non posologiques à discuter ; ne propose, ne calcule et ne recopie aucune dose.
Ne mentionne aucun nom, adresse e-mail ou identifiant. Réponds en français.
Le niveau global ne doit jamais minimiser une alerte des règles.
"""


def apply_opinion(rules_level, opinion):
    """Keep the more severe level; AI is permitted only to raise the rule result."""
    data = opinion.model_dump() if isinstance(opinion, BaseModel) else dict(opinion)
    if rules_level not in SEVERITY_ORDER or data.get("overall_level") not in SEVERITY_ORDER:
        raise ValueError("Niveau de gravité invalide dans l'avis Pharma-Check.")
    data["final_level"] = max(
        (rules_level, data["overall_level"]), key=SEVERITY_ORDER.index
    )
    return data


def run_agent(check):
    from langchain.agents import create_agent
    from langchain.tools import tool
    from langchain_openai import ChatOpenAI

    rules = {
        "niveau_maximal": check.max_severity,
        "alertes": check.findings,
        "lignes": check.checked_items,
    }
    context = patient_context(check.record)

    @tool
    def resultats_regles() -> str:
        """Renvoie les alertes déterministes et les lignes de médicaments contrôlées."""
        return json.dumps(rules, ensure_ascii=False)

    @tool
    def contexte_patient() -> str:
        """Renvoie le contexte clinique utile sans nom, e-mail ni identifiant."""
        return json.dumps(context, ensure_ascii=False)

    model = ChatOpenAI(
        model=settings.PHARMACHECK_AI_MODEL,
        api_key=settings.OPENAI_API_KEY,
        temperature=0,
        timeout=settings.PHARMACHECK_AI_TIMEOUT,
        max_retries=1,
    )
    agent = create_agent(
        model,
        tools=[resultats_regles, contexte_patient],
        system_prompt=SYSTEM_PROMPT,
        response_format=PharmacheckOpinion,
    )
    state = agent.invoke({
        "messages": [{
            "role": "user",
            "content": "Fournis une seconde lecture des lignes de prescription fournies, sans proposer de dose.",
        }]
    })
    return state["structured_response"]


def analyse(check):
    """Fill an AI status and retain the rule-only result on any provider/schema failure."""
    try:
        report = run_agent(check)
        check.ai_opinion = apply_opinion(check.max_severity, report)
        check.ai_model = settings.PHARMACHECK_AI_MODEL
        check.ai_status = PrescriptionCheck.AIStatus.DONE
        check.ai_error = ""
    except Exception as exc:
        logger.warning("Pharmacheck AI check %s failed: %s", check.pk, exc)
        check.ai_status = PrescriptionCheck.AIStatus.ERROR
        check.ai_error = f"{exc.__class__.__name__}: {exc}"[:300]
    check.save(update_fields=["ai_status", "ai_opinion", "ai_error", "ai_model"])
    return check


def _run_in_thread(pk):
    close_old_connections()
    try:
        check = PrescriptionCheck.objects.select_related(
            "record__patient__patient_profile"
        ).get(pk=pk)
        analyse(check)
    finally:
        connection.close()


def start_analysis(check):
    if not settings.PHARMACHECK_AI_ENABLED:
        raise RuntimeError("Avis IA désactivé : clé OpenAI absente ou analyse désactivée.")
    check.ai_status = PrescriptionCheck.AIStatus.RUNNING
    check.ai_error = ""
    check.save(update_fields=["ai_status", "ai_error"])
    if settings.PHARMACHECK_AI_ASYNC:
        threading.Thread(target=_run_in_thread, args=(check.pk,), daemon=True).start()
        return check
    return analyse(check)


def mark_stale(check):
    if check.ai_status == PrescriptionCheck.AIStatus.RUNNING and (
        timezone.now() - check.created_at >= PrescriptionCheck.STALE_AFTER
    ):
        check.ai_status = PrescriptionCheck.AIStatus.ERROR
        check.ai_error = "L'analyse a dépassé le délai maximal de cinq minutes."
        check.save(update_fields=["ai_status", "ai_error"])
    return check
