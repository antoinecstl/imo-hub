import { z } from 'zod';

/**
 * Forme de réponse attendue de la recherche Leboncoin, d'après les types du dépôt
 * thomasync/leboncoin-api-search (commit 8de9b55). Ce n'est PAS une spécification officielle :
 * on valide seulement ce que l'adaptateur utilise et on laisse passer le reste.
 * Les clés d'attributs immobiliers (square, rooms, energy_rate…) ne figurent pas dans ce dépôt :
 * ce sont des hypothèses à confirmer sur un échantillon réel obtenu dans un cadre autorisé.
 */
export const LbcAttribute = z
  .object({ key: z.string(), value: z.string().nullish(), value_label: z.string().nullish() })
  .passthrough();

export const LbcOwner = z
  .object({ type: z.string().nullish(), name: z.string().nullish() })
  .passthrough();

export const LbcAd = z
  .object({
    list_id: z.union([z.number().int(), z.string().regex(/^\d+$/)]),
    subject: z.string().nullish(),
    body: z.string().nullish(),
    url: z.string().nullish(),
    category_id: z.string().nullish(),
    ad_type: z.string().nullish(),
    price: z.array(z.number()).nullish(),
    first_publication_date: z.string().nullish(),
    index_date: z.string().nullish(),
    attributes: z.array(LbcAttribute).nullish(),
    // Dans les types du dépôt, owner et has_phone sont imbriqués dans `location` (probable erreur
    // d'accolade). On accepte les deux emplacements.
    owner: LbcOwner.nullish(),
    has_phone: z.boolean().nullish(),
    location: z
      .object({
        city: z.string().nullish(),
        city_label: z.string().nullish(),
        zipcode: z.string().nullish(),
        lat: z.number().nullish(),
        lng: z.number().nullish(),
        is_shape: z.boolean().nullish(),
        owner: LbcOwner.nullish(),
        has_phone: z.boolean().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type LbcAd = z.infer<typeof LbcAd>;

export const LbcSearchResponse = z
  .object({
    total: z.number().int().nonnegative(),
    max_pages: z.number().int().nonnegative().nullish(),
    pivot: z.string().nullish(),
    // Chaque annonce est validée individuellement : une annonce mal formée ne fait pas échouer la page.
    ads: z.array(z.unknown()).nullish(),
  })
  .passthrough();
export type LbcSearchResponse = z.infer<typeof LbcSearchResponse>;
