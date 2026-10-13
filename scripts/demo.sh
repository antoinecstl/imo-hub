#!/usr/bin/env bash
# Démonstration de bout en bout sur fixtures : import, rejeu, changement de prix, blocage.
set -euo pipefail
cd "$(dirname "$0")/.."
W="pnpm -s worker"
F=tests/fixtures

echo "== 1. Import CSV de l'agence (13/10)"
$W import $F/import/annonces-pilote-2026-10-13.csv --source import-agence --name "Import agence pilote" --observed-at 2026-10-13T07:00:00+02:00
echo "== 2. Rejeu du même fichier : aucune écriture"
$W import $F/import/annonces-pilote-2026-10-13.csv --source import-agence --observed-at 2026-10-13T07:00:00+02:00
echo "== 3. Export du 14/10 : un prix a baissé"
$W import $F/import/annonces-pilote-2026-10-14.csv --source import-agence --observed-at 2026-10-14T07:00:00+02:00
echo "== 4. Fichier avec lignes invalides : collecte partielle"
$W import $F/import/annonces-invalides.json --source import-partenaire --name "Import partenaire (exemple invalide)"
echo "== 5. Leboncoin sur fixtures (3 pages), puis variante avec un prix modifié"
$W leboncoin-fixtures $F/leboncoin/vannes-3-pages --locations 56000,56860
$W leboncoin-fixtures $F/leboncoin/vannes-prix-modifie --locations 56000,56860
echo "== 6. Leboncoin renvoie un CAPTCHA : source bloquée, rien d'autre n'est touché"
$W leboncoin-fixtures $F/leboncoin/captcha --locations 56000,56860
echo "== 7. PAP sur fixtures : Nice (2 pages) et Saint-Germain-en-Laye"
$W pap-fixtures $F/pap/pilote --search-urls https://www.pap.fr/annonce/vente-immobiliere-nice-06-fixture,https://www.pap.fr/annonce/vente-immobiliere-saint-germain-en-laye-78-fixture
echo
echo "Page technique : pnpm web, puis http://127.0.0.1:3000/"
