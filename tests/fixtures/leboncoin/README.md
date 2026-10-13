# Fixtures Leboncoin — données synthétiques

Ces réponses sont **fabriquées à la main** d'après les types du dépôt
`thomasync/leboncoin-api-search` (commit 8de9b55). Elles ne proviennent d'aucune collecte réelle :
identifiants (900000001…), textes, prix et coordonnées sont fictifs.

Elles servent à tester le parsing, la pagination par pivot et la gestion des erreurs hors ligne.
Elles ne prouvent pas que la source répond aujourd'hui sous cette forme. Les clés d'attributs
immobiliers (`real_estate_type`, `square`, `rooms`, `energy_rate`, `ges`, `land_plot_surface`)
sont des hypothèses à confirmer sur un échantillon obtenu dans un cadre autorisé.

| Dossier | Scénario |
|---|---|
| `vannes-3-pages` | 3 pages, une annonce répétée entre les pages 1 et 2, dernière page sans pivot, prix à 0, DPE « v », surface absente |
| `vannes-prix-modifie` | Même périmètre, prix de 900000002 passé de 229 000 € à 215 000 € |
| `captcha` | Page HTML de challenge renvoyée avec un statut 200 |
| `forbidden` | Statut 403 avec redirection vers un CAPTCHA |
| `schema-inattendu` | JSON valide mais sans les champs attendus |
