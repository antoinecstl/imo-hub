# Imo-hub : consignes pour Claude Code

Plateforme de données immobilières (annonces + DPE). Monorepo pnpm TypeScript sans build, PostgreSQL 16 + PostGIS.
Lire `README.md` pour l'organisation et `docs/decisions/` pour les choix déjà faits. Répondre en français.

## Mise en route

1. Node 22+ et pnpm 10 (`corepack enable` suffit souvent).
2. PostgreSQL 16 + PostGIS, avec les bases `imo` et `imo_test` (rôle `imo`, mot de passe `imo`) :
   - avec Docker : `pnpm db:up` ;
   - sans Docker (poste où on ne peut pas l'installer) : un PostgreSQL local avec PostGIS (Postgres.app sur macOS,
     `brew install postgresql@16 postgis`, ou l'installeur EDB + Stack Builder sur Windows), puis :
     `CREATE ROLE imo LOGIN PASSWORD 'imo'; CREATE DATABASE imo OWNER imo; CREATE DATABASE imo_test OWNER imo;`
     et `CREATE EXTENSION postgis;` dans chacune des deux bases, en superutilisateur.
   Ne rien installer au niveau système sans le demander à l'utilisateur : c'est peut-être un poste professionnel.
3. `pnpm install`, `cp .env.example .env`, `export DATABASE_URL=postgres://imo:imo@localhost:5432/imo`, `pnpm db:migrate`.
4. `pnpm test` (tout doit passer, aucun appel réseau) et `pnpm typecheck`.

## Règles à respecter

- Aucun contournement de CAPTCHA, de blocage ou de limite : pas de cookie anti-robot, de clé d'application ni de
  User-Agent emprunté. Un refus est un résultat à documenter, pas un obstacle à forcer (`docs/decisions/0006-tests-reels.md`).
- Leboncoin et PAP ne sont interrogés en réel qu'après l'accord explicite de l'utilisateur dans la conversation
  (« go sonde »), puis `pnpm worker source authorize <id> --note "<accord, nom, date>"`. 1 page, jamais plus de 2.
- Les enregistrements `tests/fixtures/**/reel-*` restent hors Git (données personnelles possibles). Ne versionner
  qu'un extrait minimisé (quelques lignes, textes libres et contacts retirés) si un test en a besoin.
- Les hypothèses de format sont signalées dans le code ; quand le réel les contredit, corriger le code ET la décision
  correspondante dans `docs/decisions/`.

## Mission « tests réels »

Quand l'utilisateur demande de lancer les tests réels :

1. Mise en route ci-dessus, `pnpm test` vert.
2. Import ADEME réel, Nice + Saint-Germain-en-Laye (données ouvertes, ~111 pages de 1 000 DPE, de quelques minutes à une demi-heure) :
   ```bash
   D=$(date +%F)
   pnpm worker ademe --insee 06088,78551 --postal-raw 06000,06100,06200,06300,78100,78112 --record tests/fixtures/ademe/reel-$D
   ```
   Si la collecte s'interrompt, relancer avec `--resume <runId>` (affiché par la commande).
3. Seulement si l'utilisateur a dit « go sonde » :
   ```bash
   pnpm worker source authorize leboncoin --note "sonde 1 page autorisée par <nom> le $D"
   pnpm worker leboncoin --locations 06000 --max-pages 1 --record tests/fixtures/leboncoin/reel-$D
   pnpm worker source authorize pap --note "sonde 1 page autorisée par <nom> le $D"
   pnpm worker pap --search-urls "<URL de recherche PAP fournie par l'utilisateur>" --max-pages 1 --record tests/fixtures/pap/reel-$D
   ```
4. `pnpm test:reel` rejoue chaque enregistrement dans le pipeline : format lu, moins de 5 % de rejets, rejeu sans doublon.
   En cas d'échec, lire la réponse enregistrée, corriger `parse.ts` / `normalize.ts` / `connector.ts`, ajouter un test
   sur un extrait minimisé, et recommencer jusqu'au vert.
5. Comparer aux chiffres attendus de `docs/analyses/2026-10-13-ademe-nice-saint-germain.md`
   (96 499 DPE à Nice, 14 293 à Saint-Germain-en-Laye au 13/10/2026) avec `pnpm web` puis `/api/quality/dpe-freshness`
   et `/api/quality/completeness`, ou directement en SQL.
6. Écrire `docs/analyses/<date>-tests-reels.md` : commandes lancées, statut de chaque collecte, volumes, durées,
   rejets et leurs causes, écarts entre le format réel et les hypothèses, corrections apportées, refus éventuels.
7. Créer une branche `resultats-reels-<date>`, committer le rapport et les corrections (sans les dossiers `reel-*`),
   pousser et ouvrir une pull request vers `main`. Le travail en cours dans le projet Claude reprend à partir d'elle.
