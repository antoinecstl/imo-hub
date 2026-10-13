# Fixtures PAP — données synthétiques

Pages HTML **fabriquées à la main**, aucune ne provient de pap.fr. Elles reposent sur une hypothèse non vérifiée :
les pages de résultats exposent les annonces en JSON-LD schema.org (`ItemList` → `Offer` → `Apartment`/`House`)
et la page suivante par `rel="next"`. Identifiants r900000101… et textes fictifs.

| Dossier | Scénario |
|---|---|
| `pilote` | Nice sur 2 pages (une annonce répétée, un prix absent), Saint-Germain-en-Laye sur 1 page |
| `prix-baisse` | Même périmètre, r900000101 passé de 489 000 € à 469 000 € |
| `anomalies` | CAPTCHA, 403, page sans JSON-LD (format changé), résultats vides |
