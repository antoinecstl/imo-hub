# 0002 — Annonces, observations, snapshots et statuts de collecte

Date : 13 octobre 2026 · Statut : adopté

## Valeurs absentes
Toute valeur inconnue vaut `null`. Aucun défaut n'est inventé : pas de prix à 0, pas d'euro supposé
(un prix sans devise est rejeté à l'import), pas de classe DPE pour « vierge », pas de téléphone.
`sourceHasPhone` reproduit l'indicateur `has_phone` de la source ; ce n'est pas un numéro.

## Stockage
- `listings` : une ligne par (source, identifiant externe), avec une copie des valeurs courantes pour la recherche.
- `listing_snapshots` : une version du contenu normalisé, créée seulement quand l'empreinte du contenu change.
- `listing_observations` : « l'annonce a été vue lors de telle collecte » ; unique par (annonce, collecte).
  Rejouer une page reprise ne duplique rien ; une nouvelle collecte ajoute une observation, ce qui constitue l'historique.
- `listing_events` : `appeared`, `price_changed`, `modified`, `not_seen`, `reappeared`, uniques par (annonce, collecte, type).
- Un export plus ancien importé après coup ajoute un snapshot et une observation, sans réécrire l'état courant ni émettre d'événement.
- Seule l'empreinte de la donnée brute est conservée (`raw_hash`) tant que les droits de conservation ne sont pas qualifiés.

## Statuts de collecte
| Statut | Signification |
|---|---|
| `complete` | Toutes les pages ont été lues, aucune ligne rejetée, pas de troncature |
| `partial` | Interruption après au moins une page, troncature (source ou plafond), ou lignes rejetées |
| `blocked` | Refus, 429, CAPTCHA/challenge, source désactivée ou accès réel non autorisé. Aucune nouvelle tentative |
| `failed` | Erreur technique ou format inattendu sans aucune page exploitable |

Les erreurs temporaires (réseau, HTTP 5xx) sont retentées deux fois avec temporisation exponentielle. Chaque page
est écrite dans sa propre transaction avec le curseur suivant : `--resume <runId>` reprend là où la collecte s'est arrêtée.
Un même fichier (même empreinte SHA-256) n'est importé qu'une fois.

## Absence ≠ retrait
Une annonce passe en `not_seen` uniquement après N collectes (2 par défaut) à la fois `complete` et
exhaustives sur le même périmètre. Une collecte en échec, bloquée ou partielle ne compte jamais.
`not_seen` n'est ni « retirée » ni « vendue » : ces interprétations relèvent du chantier 2.
Aujourd'hui, seul un import déclaré `--exhaustive` peut être exhaustif ; la recherche Leboncoin ne l'est pas,
faute de mesure de couverture.
