# 0001 — Monorepo TypeScript, PostgreSQL/PostGIS, web + worker

Date : 13 octobre 2026 · Statut : adopté

- Un monorepo pnpm, sans étape de compilation : les paquets exportent leurs sources TypeScript, exécutées par `tsx` et testées par `vitest`.
- Deux processus déployables : `apps/web` (lecture) et `apps/worker` (collecte). Pas de microservices.
- PostgreSQL 16 + PostGIS 3.4. Migrations SQL versionnées, appliquées dans l'ordre par `packages/db` (table `schema_migrations`).
- Contrats partagés en zod dans `packages/contracts` : le même schéma valide les adaptateurs, les imports et sert de type.
- Les tests ne font aucun appel réseau. Les tests d'intégration utilisent la base `imo_test` et s'exécutent en série.
- Choix restant ouvert : l'ordonnanceur de tâches (cron simple, pg-boss…) n'est pas encore retenu ; la reprise repose pour l'instant sur le curseur stocké par collecte.
