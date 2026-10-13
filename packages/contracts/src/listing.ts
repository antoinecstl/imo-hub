import { z } from 'zod';

/**
 * Contrat métier d'une annonce, indépendant du format de chaque source.
 * Règle : une valeur inconnue vaut `null`. On n'invente jamais une valeur par défaut
 * (pas de prix à 0, pas de surface déduite, pas de téléphone déduit de `has_phone`).
 */
export const TransactionType = z.enum(['sale', 'rent']);
export const PropertyType = z.enum(['house', 'apartment', 'land', 'parking', 'other']);
export const SellerType = z.enum(['private', 'professional']);
export const SurfaceKind = z.enum(['living', 'carrez', 'land']);
export const LocationPrecision = z.enum(['exact', 'street', 'city', 'postal_code']);
export const EnergyClass = z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G']);

const nullable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable();
const isoDateTime = z.string().datetime({ offset: true });

export const NormalizedListing = z
  .object({
    sourceId: z.string().min(1),
    externalId: z.string().min(1),
    sourceUrl: nullable(z.string().url()),
    transactionType: nullable(TransactionType),
    propertyType: nullable(PropertyType),
    sellerType: nullable(SellerType),
    title: nullable(z.string()),
    description: nullable(z.string()),
    price: nullable(z.number().int().positive()),
    currency: nullable(z.literal('EUR')),
    surfaceValue: nullable(z.number().positive()),
    surfaceKind: nullable(SurfaceKind),
    landSurface: nullable(z.number().positive()),
    rooms: nullable(z.number().int().positive()),
    bedrooms: nullable(z.number().int().nonnegative()),
    city: nullable(z.string().min(1)),
    postalCode: nullable(z.string().regex(/^\d{5}$/)),
    inseeCode: nullable(z.string().regex(/^[0-9AB]{5}$/)),
    addressText: nullable(z.string()),
    latitude: nullable(z.number().min(-90).max(90)),
    longitude: nullable(z.number().min(-180).max(180)),
    locationPrecision: nullable(LocationPrecision),
    energyClass: nullable(EnergyClass),
    energyValue: nullable(z.number().nonnegative()),
    gesClass: nullable(EnergyClass),
    gesValue: nullable(z.number().nonnegative()),
    dpeNumber: nullable(z.string().min(1)),
    /** Indicateur fourni par la source. Ce n'est PAS un numéro de téléphone. */
    sourceHasPhone: nullable(z.boolean()),
    sourcePublishedAt: nullable(isoDateTime),
    sourceUpdatedAt: nullable(isoDateTime),
  })
  .strict()
  .refine((l) => (l.price === null) === (l.currency === null), {
    message: 'price et currency doivent être tous deux renseignés ou tous deux absents',
    path: ['currency'],
  })
  .refine((l) => (l.surfaceValue === null) === (l.surfaceKind === null), {
    message: 'surfaceValue et surfaceKind doivent être tous deux renseignés ou tous deux absents',
    path: ['surfaceKind'],
  })
  .refine((l) => (l.latitude === null) === (l.longitude === null), {
    message: 'latitude et longitude vont ensemble',
    path: ['longitude'],
  });
export type NormalizedListing = z.infer<typeof NormalizedListing>;

/** Champs métier comparés pour détecter une modification (hors identité). */
export const LISTING_CONTENT_FIELDS = [
  'sourceUrl', 'transactionType', 'propertyType', 'sellerType', 'title', 'description',
  'price', 'currency', 'surfaceValue', 'surfaceKind', 'landSurface', 'rooms', 'bedrooms',
  'city', 'postalCode', 'inseeCode', 'addressText', 'latitude', 'longitude', 'locationPrecision',
  'energyClass', 'energyValue', 'gesClass', 'gesValue', 'dpeNumber', 'sourceHasPhone',
  'sourcePublishedAt', 'sourceUpdatedAt',
] as const satisfies readonly (keyof NormalizedListing)[];

/** Construit une annonce dont tous les champs connus sont à null, à compléter par l'adaptateur. */
export function emptyListing(sourceId: string, externalId: string): NormalizedListing {
  return {
    sourceId, externalId, sourceUrl: null, transactionType: null, propertyType: null, sellerType: null,
    title: null, description: null, price: null, currency: null, surfaceValue: null, surfaceKind: null,
    landSurface: null, rooms: null, bedrooms: null, city: null, postalCode: null, inseeCode: null,
    addressText: null, latitude: null, longitude: null, locationPrecision: null, energyClass: null,
    energyValue: null, gesClass: null, gesValue: null, dpeNumber: null, sourceHasPhone: null,
    sourcePublishedAt: null, sourceUpdatedAt: null,
  };
}
