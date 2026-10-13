import { emptyListing, EnergyClass, NormalizedListing } from '@imo/contracts';
import { parisLocalToIso } from '../util.ts';
import type { LbcAd } from './schema.ts';

export const LBC_SOURCE_ID = 'leboncoin';
export const LBC_PARSER_VERSION = 'leboncoin@0.1.0';

const PROPERTY_TYPES: Record<string, NormalizedListing['propertyType']> = {
  '1': 'house', '2': 'apartment', '3': 'land', '4': 'parking', '5': 'other',
};
const TRANSACTION_BY_CATEGORY: Record<string, NormalizedListing['transactionType']> = { '9': 'sale', '10': 'rent' };

function attr(ad: LbcAd, key: string): string | null {
  const found = ad.attributes?.find((a) => a.key === key);
  const v = found?.value;
  return v === undefined || v === null || v.trim() === '' ? null : v.trim();
}

function positiveNumber(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function positiveInt(v: string | null): number | null {
  const n = positiveNumber(v);
  return n !== null && Number.isInteger(n) ? n : null;
}

function energy(v: string | null): NormalizedListing['energyClass'] {
  if (v === null) return null;
  // « v » (vierge) ou « n » (non soumis) ne sont pas des classes : on garde null.
  const parsed = EnergyClass.safeParse(v.toUpperCase());
  return parsed.success ? parsed.data : null;
}

/** Transforme une annonce Leboncoin validée en annonce normalisée. Aucune valeur n'est inventée. */
export function normalizeLbcAd(ad: LbcAd): NormalizedListing {
  const l = emptyListing(LBC_SOURCE_ID, String(ad.list_id));
  l.sourceUrl = ad.url?.startsWith('https://') ? ad.url : null;
  l.transactionType = (ad.category_id && TRANSACTION_BY_CATEGORY[ad.category_id]) || null;
  l.propertyType = PROPERTY_TYPES[attr(ad, 'real_estate_type') ?? ''] ?? null;

  const owner = ad.owner ?? ad.location?.owner ?? null;
  l.sellerType = owner?.type === 'private' ? 'private' : owner?.type === 'pro' ? 'professional' : null;

  l.title = ad.subject?.trim() || null;
  l.description = ad.body?.trim() || null;

  const price = ad.price?.[0];
  if (typeof price === 'number' && Number.isInteger(price) && price > 0) {
    l.price = price;
    l.currency = 'EUR';
  }

  const square = positiveNumber(attr(ad, 'square'));
  if (square !== null) {
    l.surfaceValue = square;
    l.surfaceKind = 'living';
  }
  l.landSurface = positiveNumber(attr(ad, 'land_plot_surface'));
  l.rooms = positiveInt(attr(ad, 'rooms'));
  const bedrooms = attr(ad, 'bedrooms');
  l.bedrooms = bedrooms !== null && /^\d+$/.test(bedrooms) ? Number(bedrooms) : null;

  const loc = ad.location;
  l.city = loc?.city?.trim() || null;
  l.postalCode = loc?.zipcode && /^\d{5}$/.test(loc.zipcode) ? loc.zipcode : null;
  if (typeof loc?.lat === 'number' && typeof loc?.lng === 'number') {
    l.latitude = loc.lat;
    l.longitude = loc.lng;
  }
  // Les coordonnées publiées sont approximatives : précision à l'échelle de la commune au mieux.
  l.locationPrecision = l.city !== null || l.latitude !== null ? 'city' : null;

  l.energyClass = energy(attr(ad, 'energy_rate'));
  l.gesClass = energy(attr(ad, 'ges'));

  // Simple indicateur de la source ; aucun numéro n'est collecté ni déduit.
  const hasPhone = ad.has_phone ?? loc?.has_phone;
  l.sourceHasPhone = typeof hasPhone === 'boolean' ? hasPhone : null;

  l.sourcePublishedAt = parisLocalToIso(ad.first_publication_date);
  l.sourceUpdatedAt = parisLocalToIso(ad.index_date);
  return l;
}
