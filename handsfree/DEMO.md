# Démonstration Navigation mains libres (2 minutes)

1. Sur la page d'accueil, ouvrez **Accessibilité**, choisissez **Yeux + mains (recommandé)** et acceptez l'avis caméra. Le visage et la main sont suivis localement par MediaPipe ; aucune image n'est envoyée au serveur.
2. Activez **Aperçu caméra** pour vérifier le cadrage et l'éclairage. Choisissez **Calibrer le clignement**. Gardez les yeux ouverts pendant la première étape, puis clignez plusieurs fois normalement pendant la seconde. Les seuils sont enregistrés dans ce navigateur.
3. En mode **Yeux**, le marqueur rouge suit approximativement vos iris. Regardez un bouton ou un lien, puis clignez une fois pour cliquer. Regardez le haut ou le bas de l'écran pour faire défiler.
4. En mode **Mains**, gardez une main entière visible, paume tournée vers la caméra. Le curseur suit le bout de l'index. Visez une cible entourée en rouge, rapprochez le pouce et l'index, maintenez brièvement, puis relâchez pour cliquer. Gardez le pincement et déplacez l'index verticalement pour faire défiler.
5. Montrez la paume ouverte pendant une seconde pour mettre en pause ou reprendre. Le suivi des yeux et des mains partage le même flux caméra.
6. Regardez le bouton d'accessibilité pour l'ouvrir, puis utilisez **Pause**/**Reprendre** et **Arrêter** dans le panneau flottant. `Alt+Maj+G` active ou arrête le dernier mode choisi.
7. Dans une téléconsultation de démonstration, activez mains libres et ouvrez un compte rendu de laboratoire. Vérifiez que le suivi continue indépendamment de la caméra envoyée au correspondant ; le flux mains libres est un flux séparé, local et basse résolution.

## Limites connues

- Une caméra, un navigateur compatible, un contexte HTTPS (ou localhost) et l'autorisation caméra sont nécessaires. Les performances et la précision varient selon l'éclairage, la caméra et l'appareil.
- La calibration règle la sensibilité du clignement pour cette caméra. Le marqueur de regard reste approximatif ; recentrez votre visage si le pointage dérive.
- La précision dépend de l'éclairage, de la caméra et de l'angle du visage. Gardez les yeux et la main dans le cadre pendant leur mode de suivi.
- Le navigateur bloque les clics synthétiques qui ouvriraient un sélecteur de fichier ou une demande d'autorisation. Ces actions exigent un vrai clic.
- Les données visuelles sont traitées dans le navigateur. Les scripts et le modèle de vision sont téléchargés depuis jsDelivr et Google Storage uniquement après activation d'un mode correspondant.
- Les tests automatisés valident la logique et l'intégration HTML, pas le fonctionnement d'une caméra réelle ni les mouvements du pointeur.
