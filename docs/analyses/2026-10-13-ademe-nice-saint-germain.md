# DPE ADEME sur Nice et Saint-Germain-en-Laye — premier état des lieux

Date : 13 octobre 2026 · Jeu : « DPE Logements existants (depuis juillet 2021) », `meg-83tjwtg8dyz4vv7h1dqe`

**Méthode et limite.** Le réseau de l'environnement de développement bloque `data.ademe.fr` : l'import réel n'a
pas pu être lancé (collecte `failed`, erreur réseau, comme attendu). Les chiffres ci-dessous viennent de requêtes
de comptage sur l'API publique, lues via un outil de lecture web le 13/10/2026 vers 20 h UTC. Ils sont à
confirmer par le premier import réel ; les requêtes sont données pour les rejouer.

## Le jeu de données

- 15 705 770 DPE en France, 230 champs, Licence Ouverte 2.0, fréquence annoncée : hebdomadaire.
- Métadonnée `dataUpdatedAt` : 2026-10-01, alors que des DPE reçus le 2026-10-05 sont déjà présents : la date
  de mise à jour du jeu ne mesure pas la fraîcheur. On mesure donc la fraîcheur par `max(date_reception_dpe)`.

## Volumes

| | Nice (06088) | Saint-Germain-en-Laye (78551) |
|---|---:|---:|
| DPE depuis juillet 2021 | 96 499 | 14 293 |
| Appartements | 91 091 (94,4 %) | 12 634 (88,4 %) |
| Maisons | 3 077 (3,2 %) | 1 219 (8,5 %) |
| Immeubles | 2 331 (2,4 %) | 440 (3,1 %) |
| Reçus en septembre 2025 | 1 604 | 137 |
| Reçus en septembre 2026 | 1 409 | 165 |
| Reçus depuis le 13/09/2026 | 1 039 | 123 |
| DPE remplaçant un DPE antérieur | 6 917 (7,2 %) | 1 259 (8,8 %) |
| Géocodés à l'adresse (BAN) | 68 776 (71,3 %) | 10 035 (70,2 %) |
| Non géocodés | 27 723 (28,7 %) | 4 258 (29,8 %) |
| Code postal brut de la commune mais code INSEE différent ou absent | 563 (brut 06100) | 307 (brut 78100/78112) |

Ordre de grandeur du flux : environ 50 nouveaux DPE par jour à Nice, 5 à Saint-Germain-en-Laye.
L'import initial des deux communes représente environ 111 000 lignes, soit ~111 requêtes de 1 000 lignes.

## Latence

Au 13/10, le DPE le plus récent est reçu le 2026-10-05 dans les deux communes, soit **8 jours** de retard
pour une publication hebdomadaire. Sur l'échantillon des DPE les plus récents, dates d'établissement, de réception
et de dernière modification sont identiques : le retard vient de la publication, pas de la transmission.
Septembre 2026 est proche de septembre 2025 : un mois est quasiment complet après une à deux semaines.

## Ce que cela change pour le produit

1. **Pas de temps réel.** Un nouveau DPE apparaît chez nous une à deux semaines après sa réalisation.
   Synchronisation hebdomadaire sur `date_derniere_modification_dpe`, avec 14 jours de chevauchement.
2. **Près de 30 % des DPE ne sont pas géocodés.** Le rapprochement par coordonnées BAN ne marche que pour 70 %.
   Il faudra géocoder nous-mêmes `adresse_brut` (GEO-01) pour le reste.
3. **7 à 9 % des DPE en remplacent un autre.** Le DPE remplacé ne doit pas compter comme un nouveau signal ;
   l'API exclut par défaut les DPE remplacés.
4. **Le filtre par code INSEE seul en manque.** 563 et 307 DPE portent un code postal brut de la commune
   sans le code INSEE attendu. Le connecteur sait les inclure (`--postal-raw`) ; à trier ensuite.
5. **Les appartements dominent, surtout à Nice.** Le rapprochement DPE ↔ annonce sera difficile dans les
   immeubles : `complement_adresse_logement` est du texte libre (« 2eme droite », « Bat. F; Esc. 1; Etage 2 ») et
   `numero_etage_appartement` peut le contredire (0 pour un logement décrit « Etage 2 » dans l'échantillon).
   Surface, étiquettes et valeurs énergie/GES seront les critères principaux, avec plusieurs candidats par immeuble.

## Requêtes utilisées

Base : `https://data.ademe.fr/data-fair/api/v1/datasets/meg-83tjwtg8dyz4vv7h1dqe`

- Total : `/lines?size=0&qs=code_insee_ban:06088`
- Répartition : `/values_agg?field=type_batiment&qs=code_insee_ban:06088` (idem `statut_geocodage`)
- Remplacements : `/lines?size=0&qs=code_insee_ban:06088 AND _exists_:numero_dpe_remplace`
- Mois : `/lines?size=0&qs=code_insee_ban:06088 AND date_reception_dpe:[2026-09-01 TO 2026-09-30]`
- Récents : `/lines?size=15&sort=-date_reception_dpe&qs=code_insee_ban:06088`
- Hors INSEE : `/lines?size=0&qs=code_postal_brut:6100 AND NOT code_insee_ban:06088`
