# 0006 — Tester en conditions réelles : sondes limitées et réponses enregistrées

Date : 13 octobre 2026 · Statut : adopté

## Problème
Les adaptateurs Leboncoin et PAP étaient écrits sur un format supposé, et l'import ADEME n'avait jamais tourné :
l'environnement cloud de développement bloque `data.ademe.fr`, et aucune requête réelle n'était faite vers les portails.

## Architecture retenue
1. **Exécution sur une machine au réseau ouvert** : le poste d'Antoine (session Claude Code locale) ou un environnement
   cloud autorisant les domaines nécessaires. Les portails refusent souvent les IP de centres de données ; une connexion
   résidentielle donne un résultat plus représentatif.
2. **Sondes bornées** (`worker leboncoin`, `worker pap`) : 1 page par défaut, budget de requêtes égal au nombre de pages,
   5 s entre deux appels, robots.txt respecté, aucune nouvelle tentative, arrêt au premier refus ou CAPTCHA.
   User-Agent explicite `imo-hub/…` ; aucun cookie anti-robot, clé d'application ou User-Agent emprunté (contrairement
   au dépôt tiers, qui embarque un cookie DataDome et se présente comme l'application iOS).
3. **Garde d'accès** : une source portail n'est interrogée que si `access_status = 'authorized'`, posé par
   `worker source authorize <id> --note "<décision>"`. Un refus (403, 429, CAPTCHA, robots.txt) la repasse
   automatiquement en `blocked` : il faut une nouvelle décision pour réessayer.
4. **Enregistrement** (`--record <dossier>`) : chaque réponse réelle est sauvegardée au format des fixtures
   (`index.json` + fichiers). On la rejoue ensuite dans les tests : le format testé devient le format réel.
   Les enregistrements contiennent des données personnelles possibles (textes d'annonces) : ils restent hors Git
   (`tests/fixtures/**/reel-*` est ignoré) tant qu'ils ne sont pas minimisés.
5. **Rejeu** : `--record` écrit aussi `scope.json` ; `pnpm test:reel` rejoue chaque dossier `reel-*` dans le pipeline
   (aucune erreur de schéma, moins de 5 % de rejets, rejeu sans doublon ; une source bloquée est acceptée comme résultat).
6. **Exécution locale guidée** : `CLAUDE.md` décrit la « mission tests réels » pour une session Claude Code sur le poste
   de l'utilisateur, qui rapporte ses résultats par une pull request (`docs/analyses/<date>-tests-reels.md`).
7. **ADEME** : données ouvertes, source autorisée d'office ; `worker ademe … --record <dossier>`.

## Ce que la sonde peut conclure
- `complete`/`partial` avec annonces : le format réel est lu ; comparer aux hypothèses et corriger `parse.ts`/`normalize.ts`.
- `failed/unexpected_schema` : la source répond mais pas sous la forme supposée ; l'enregistrement montre la vraie forme.
- `blocked` : la source refuse un accès automatisé honnête. C'est un résultat : il faut un autre canal
  (partenariat, flux autorisé, export), pas un contournement.
