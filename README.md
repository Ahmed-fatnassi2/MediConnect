# MediConnect

**Une plateforme pédagogique de suivi médical** qui relie patients, médecins et équipes de soins autour du triage, des rendez-vous, des dossiers et du suivi après consultation.

> **Démo en ligne :** [mediconnect-ni0o.onrender.com](https://mediconnect-ni0o.onrender.com/)

MediConnect est un projet académique. Il ne remplace pas l'avis d'un professionnel de santé. Les résultats des fonctions d'IA sont des aides à la décision, à vérifier par un médecin.

## Fonctionnalités

- **Espaces patient et médecin** avec inscription, profils et tableaux de bord par rôle.
- **Triage des symptômes** avec règles déterministes et analyse IA facultative.
- **Rendez-vous** avec disponibilités médicales, demandes et décisions de réservation.
- **Téléconsultation** avec salle de consultation et échanges patient-médecin.
- **Dossiers médicaux** comprenant consultations, documents et ordonnances.
- **Plans de suivi** rattachés aux rendez-vous : tâches avec échéances, statuts et progression du patient. L'IA peut proposer un brouillon que le médecin relit.
- **Pharma-Check** : contrôles locaux des allergies, interactions et doses, avec une seconde lecture IA facultative.
- **Vérification documentaire des médecins** assistée par IA, avec décision finale réservée à l'équipe habilitée.
- **Navigation mains libres** par suivi du regard et gestes, activée à la demande dans le navigateur.

## Technologies

- Python 3.12 et Django 6.1
- SQLite en développement ; PostgreSQL en hébergement
- OpenAI via LangChain pour les fonctions IA facultatives
- Gunicorn et WhiteNoise pour le service web et les fichiers statiques

## Lancer en local

```bash
python3.12 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python manage.py migrate
python manage.py seed_demo
python manage.py seed_pharmacheck_demo
python manage.py runserver
```

Ouvrez [http://127.0.0.1:8000](http://127.0.0.1:8000). Sans clé OpenAI, les règles locales restent disponibles et les fonctions IA sont désactivées ou affichent leur solution de repli.

Les commandes de démonstration créent des comptes et dossiers fictifs. Consultez leurs sorties ou les guides de démonstration pour les scénarios. **N'exécutez pas ces commandes sur un environnement public avec des identifiants de démonstration.**

## Configuration

Copiez `.env.example` vers `.env` et configurez seulement les services que vous utilisez :

| Variable | Utilisation |
| --- | --- |
| `DJANGO_SECRET_KEY` | Clé secrète Django ; obligatoire en hébergement |
| `DJANGO_DEBUG` | `true` en local, `false` en hébergement |
| `DATABASE_URL` | URL PostgreSQL en hébergement ; SQLite est utilisé localement si elle est absente |
| `DJANGO_ALLOWED_HOSTS` | Noms d'hôte autorisés, séparés par des virgules |
| `CSRF_TRUSTED_ORIGINS` | Origines HTTPS autorisées, séparées par des virgules |
| `OPENAI_API_KEY` | Clé serveur pour les fonctions IA ; ne jamais la publier |
| `TRIAGE_AI_ENABLED`, `VERIFICATION_AI_ENABLED`, `DOCUMENT_AI_ENABLED`, `PHARMACECHECK_AI_ENABLED`, `FOLLOWUP_AI_ENABLED` | Activation indépendante des fonctions IA |
| `AI_BACKGROUND_ASYNC` | Exécution en arrière-plan en local ; à régler selon l'hébergeur |
| `MEDIA_ROOT` | Dossier persistant pour les documents téléversés |

Ne commitez jamais `.env`. En production, ajoutez les valeurs dans le gestionnaire de secrets de l'hébergeur. Les documents médicaux nécessitent un stockage persistant et privé.

## Déploiement Render

Le dépôt inclut un `Procfile` qui applique les migrations, collecte les fichiers statiques puis lance Gunicorn. Configurez sur Render `DJANGO_SECRET_KEY`, `DJANGO_DEBUG=false`, `DATABASE_URL`, `DJANGO_ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS` et, si l'IA est activée, `OPENAI_API_KEY`.

Les fichiers téléversés doivent être stockés sur un disque persistant ou un stockage objet privé. Le système de fichiers des services gratuits Render est éphémère ; une base PostgreSQL gratuite est temporaire. Vérifiez les limites et la facturation Render avant de choisir un plan.

## Démonstrations détaillées

- [Pharma-Check](pharmacheck/DEMO.md)
- [Navigation mains libres](handsfree/DEMO.md)

## Vérifications

```bash
python manage.py check
python manage.py test
```
