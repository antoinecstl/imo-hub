# Imo-hub — plateforme de données immobilières

Premier chantier du produit : collecter les annonces (et bientôt les DPE), les normaliser, conserver
leur historique d'observation et les exposer par API. Cette tranche verticale va d'une donnée
source jusqu'à une annonce consultable, rejouable sans doublon.

## Démarrer

Prérequis : Node 22+, pnpm 10, PostgreSQL 16 avec PostGIS 3 (ou Docker).

```bash
pnpm install
cp .env.example .env            # puis exporter DATABASE_URL
pnpm db:up                      # PostgreSQL/PostGIS via Docker (crée aussi imo_test)
pnpm db:migrate
pnpm demo                       # import, rejeu, changement de prix, blocage, sur fixtures
pnpm web                        # page technique : http://127.0.0.1:3000/
pnpm test                       # 39 tests, sans aucun appel réseau
pnpm typecheck
```

Sans Docker : créer les bases `imo` et `imo_test` (rôle `imo`) dans un PostgreSQL local avec PostGIS.

## Organisation

| Dossier | Rôle |
|---|---|
| `packages/contracts` | `NormalizedListing`, `CollectionRun`, `ConnectorResult`, interface `Connector` (zod) |
| `packages/connectors` | Adaptateurs Leboncoin et PAP (fixtures uniquement) et import CSV/JSON |
| `packages/domain` | Pipeline d'ingestion : idempotence, snapshots, événements, reprise, constat d'absence |
| `packages/db` | Pool PostgreSQL, migrations SQL |
| `apps/worker` | CLI de collecte (`pnpm worker …`) |
| `apps/web` | API de lecture (Fastify) et page technique |
| `tests/fixtures` | Réponses Leboncoin **synthétiques** et fichiers d'import d'exemple |
| `docs/decisions` | Décisions d'architecture et limites connues |

## Commandes du worker

```bash
pnpm worker import fichier.csv --source import-agence --observed-at 2026-10-13T07:00:00+02:00 [--exhaustive]
pnpm worker leboncoin-fixtures tests/fixtures/leboncoin/vannes-3-pages --locations 56000,56860 [--max-pages N] [--resume <runId>]
pnpm worker pap-fixtures tests/fixtures/pap/pilote --search-urls <url Nice>,<url Saint-Germain> [--max-pages N] [--resume <runId>]
```

Le format d'import est décrit en tête de `packages/connectors/src/file-import/connector.ts`.

## API

| Route | Contenu |
|---|---|
| `GET /api/listings` | Liste paginée. Filtres : `source`, `postalCode`, `city`, `transactionType`, `propertyType`, `sellerType`, `minPrice`, `maxPrice`, `presence`, `seenSince`, `lat`+`lng`+`radiusM`, `page`, `pageSize` (≤ 200) |
| `GET /api/listings/:id` | Valeurs courantes, snapshots, observations, événements |
| `GET /api/sources` | Sources, accès, volumes, dernière collecte |
| `GET /api/runs?source=` | Collectes avec erreurs et lignes rejetées |
| `GET /api/quality/completeness` | Taux de remplissage de chaque champ par source |
| `GET /` · `GET /listings/:id` | Page technique et fiche HTML |

## Ce qui est démontré, et ce qui ne l'est pas

- Démontré hors ligne : normalisation, pagination Leboncoin par pivot, statuts `complete/partial/blocked/failed`,
  rejeu sans doublon, changement de prix, reprise après interruption, isolation des sources, absence de faux retrait.
- **Non démontré : aucune collecte Leboncoin ni PAP réelle.** Il n'existe pas de transport réel ; voir `docs/decisions/0003-leboncoin.md` et `0005-pap.md`.
- Non commencé : regroupement des biens entre portails (chantier 2).
