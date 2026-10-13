# 0004 — Périmètre pilote

Date : 13 octobre 2026 · Statut : adopté (communes choisies par Antoine)

| Commune | Code INSEE | Codes postaux | Remarque |
|---|---|---|---|
| Nice | 06088 | 06000, 06100, 06200, 06300 | Marché d'appartements (94 % des DPE) |
| Saint-Germain-en-Laye | 78551 | 78100, 78112 | Commune nouvelle depuis 2019 : 78112 correspond à l'ancienne commune de Fourqueux |

Configuration de collecte retenue :
- DPE : `pnpm worker ademe --insee 06088,78551 --postal-raw 06000,06100,06200,06300,78100,78112`.
  Le filtre sur code postal brut rattrape les DPE mal géocodés ; le code INSEE reçu est conservé tel quel,
  l'application filtre ensuite.
- Annonces : vente résidentielle, particuliers et agences, sur les mêmes codes postaux.

Reste à fournir : une dizaine d'exemples métier (annonce, DPE connu, doublon, republication, cas non résolu)
pour constituer le jeu de référence (CAD-02).

Les fixtures Leboncoin et l'import CSV d'exemple (Vannes, Séné, Theix-Noyalo) restent des données de test synthétiques.
