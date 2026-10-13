# Fixtures ADEME — DPE logements existants

Lignes au format de l'API data-fair `meg-83tjwtg8dyz4vv7h1dqe`, limitées aux champs que demande le connecteur.
Les numéros, adresses et dates reprennent des enregistrements publics (Licence Ouverte 2.0) consultés le
13/10/2026 pour Nice et Saint-Germain-en-Laye ; **plusieurs valeurs (consommations, coordonnées, DPE remplacé
2678E2536799K) ont été complétées ou modifiées à la main** : ces fichiers servent aux tests, pas de référence.

| Dossier | Scénario |
|---|---|
| `pilote-2-pages` | 2 pages via `next` ; DPE non géocodé ; code postal brut sans zéro (6100) ; un DPE en remplace un autre ; une ligne sans numéro (rejetée) |
| `correction` | Le DPE 2606E2535225C republié avec une étiquette corrigée (C → D) |
| `quota` | HTTP 429 |
