# 0003 — Adaptateur Leboncoin : isolé, testé hors ligne, pas de collecte réelle

Date : 13 octobre 2026 · Statut : adopté pour les tests, accès réel en attente

## Lecture du dépôt tiers
Dépôt `thomasync/leboncoin-api-search`, commit `8de9b55`, lu en lecture seule (`src/search.ts`, `src/types.ts`, `README.md`).
Le dépôt n'est pas copié ni ajouté comme dépendance : l'adaptateur est réécrit derrière un `LbcTransport` injectable.

Constats vérifiés dans le code :
- `searchMultiples` sort de la boucle quand la réponse n'a pas de `pivot` **avant** d'ajouter ses annonces : la dernière page est perdue. Notre adaptateur traite la page avant de décider d'arrêter (test « conserve la dernière page »).
- `search` ne vérifie pas le statut HTTP et appelle directement `response.json()` : un 403 ou une page HTML de challenge devient une exception ou un objet sans annonces.
- Dans `types.ts`, `owner`, `has_phone` et `options` sont imbriqués dans `location` (probable erreur d'accolade). L'adaptateur accepte les deux emplacements.
- Aucune clé d'attribut immobilier n'est définie dans le dépôt. `real_estate_type`, `square`, `rooms`, `bedrooms`, `energy_rate`, `ges`, `land_plot_surface` sont **des hypothèses** à confirmer sur un échantillon réel autorisé.
- Le README indique que les tests automatisés déclenchaient un CAPTCHA.

## Ce que fait l'adaptateur
- Validation zod de l'enveloppe et de chaque annonce ; une annonce mal formée est rejetée sans perdre la page.
- Statuts : 401/403 → `blocked/forbidden` ; 429 → `blocked/rate_limited` ; page de challenge (CAPTCHA, DataDome) → `blocked/challenge` ; 5xx → `failed/http` (retenté) ; JSON inattendu → `failed/unexpected_schema`.
- Une recherche dont `total` dépasse `max_pages × limit` est signalée tronquée : la collecte devient `partial`.
- Dates locales françaises converties en UTC ; coordonnées marquées `locationPrecision = city`.

## Ce qui fonctionne hors ligne / ce qui n'est pas confirmé
| Hors ligne (fixtures synthétiques) | Non confirmé |
|---|---|
| Parsing, pagination par pivot, doublons entre pages, dernière page | Que l'API réponde encore sous cette forme |
| Statuts blocked/failed/partial, reprise | Les clés d'attributs immobiliers |
| Rejeu, changement de prix | Le comportement réel face à un CAPTCHA |

## Conditions avant tout accès réel
1. Décision écrite sur les CGU de Leboncoin et les droits de réutilisation (la licence ISC du code n'en donne aucun).
2. Source passée à `access_status = 'authorized'` en base ; le pipeline refuse sinon toute collecte par un transport réel.
3. Transport réel avec délais, concurrence 1, temporisation, et arrêt au premier refus ou challenge. Aucun contournement.

## Mise à jour du 13/10/2026
Un transport réel borné existe désormais (`LiveLbcTransport`, décision 0006). Il reste inactif tant que la source n'est pas autorisée en base.
