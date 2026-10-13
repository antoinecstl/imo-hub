import { emptyListing, type NormalizedListing } from '@imo/contracts';

export const PAP_SOURCE_ID = 'pap';
export const PAP_PARSER_VERSION = 'pap@0.1.0';

/**
 * Hypothèse de format, à confirmer sur une page réelle obtenue dans un cadre autorisé :
 * les pages de résultats PAP exposent chaque annonce en données structurées schema.org (JSON-LD),
 * et la page suivante par un lien rel="next". Lire du JSON-LD plutôt que la mise en page rend
 * l'adaptateur moins fragile aux changements visuels ; si l'hypothèse est fausse, seul ce fichier change.
 */
type Json = Record<string, unknown>;

const LISTING_TYPES = new Set(['Offer', 'RealEstateListing', 'Product', 'Apartment', 'House', 'SingleFamilyResidence', 'Residence', 'Accommodation']);

export interface PapPage {
  hasStructuredData: boolean;
  items: Json[];
  nextUrl: string | null;
}

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function types(o: Json): string[] {
  const t = o['@type'];
  return Array.isArray(t) ? t.map(String) : t ? [String(t)] : [];
}

/** Aplatit @graph, ItemList.itemListElement et ListItem.item pour obtenir les objets annonces. */
function collect(node: unknown, out: Json[]) {
  if (Array.isArray(node)) return node.forEach((n) => collect(n, out));
  if (!node || typeof node !== 'object') return;
  const o = node as Json;
  if (o['@graph']) collect(o['@graph'], out);
  if (types(o).includes('ItemList')) return collect(o.itemListElement, out);
  if (types(o).includes('ListItem')) return collect(o.item, out);
  if (types(o).some((t) => LISTING_TYPES.has(t))) out.push(o);
}

export function parsePapPage(html: string, baseUrl: string): PapPage {
  const items: Json[] = [];
  let hasStructuredData = false;
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    hasStructuredData = true;
    try {
      collect(JSON.parse(m[1]!.trim()), items);
    } catch {
      // Un bloc illisible est ignoré ; s'il n'en reste aucun, le format est jugé inattendu.
    }
  }
  const next = /<(?:link|a)\b[^>]*\brel=["']next["'][^>]*\bhref=["']([^"']+)["']/i.exec(html)
    ?? /<(?:link|a)\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']next["']/i.exec(html);
  return { hasStructuredData, items, nextUrl: next ? new URL(decodeEntities(next[1]!), baseUrl).toString() : null };
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const n = Number(v.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const obj = (v: unknown): Json | null => (Array.isArray(v) ? obj(v[0]) : v && typeof v === 'object' ? (v as Json) : null);

/** Les URL d'annonces PAP se terminent par « -r<chiffres> » : c'est l'identifiant retenu. */
export function papIdFromUrl(url: string | null): string | null {
  const m = url ? /-(r\d{6,})(?:[/?#]|$)/.exec(url) : null;
  return m ? m[1]! : null;
}

function propertyType(item: Json, offered: Json | null, text: string): NormalizedListing['propertyType'] {
  const all = [...types(item), ...(offered ? types(offered) : [])];
  if (all.includes('Apartment')) return 'apartment';
  if (all.includes('House') || all.includes('SingleFamilyResidence')) return 'house';
  if (/^\s*(appartement|studio|loft|duplex)\b/i.test(text)) return 'apartment';
  if (/^\s*(maison|villa)\b/i.test(text)) return 'house';
  if (/^\s*terrain\b/i.test(text)) return 'land';
  if (/^\s*(parking|garage|box)\b/i.test(text)) return 'parking';
  return null;
}

/** Normalise un objet JSON-LD ; renvoie null si l'identifiant est introuvable. */
export function normalizePapItem(item: Json, pageUrl: string): NormalizedListing | null {
  const offer = types(item).includes('Offer') ? item : obj(item.offers);
  const offered = obj(item.itemOffered) ?? obj(offer?.itemOffered) ?? (types(item).includes('Offer') ? null : item);
  const rawUrl = str(item.url) ?? str(offer?.url) ?? str(offered?.url);
  const url = rawUrl ? new URL(rawUrl, pageUrl).toString() : null;
  const id = papIdFromUrl(url) ?? str(item.sku) ?? str(item.identifier) ?? str(offered?.identifier);
  if (!id) return null;

  const l = emptyListing(PAP_SOURCE_ID, id);
  l.sourceUrl = url?.startsWith('https://') ? url : null;
  l.title = str(item.name) ?? str(offered?.name);
  l.description = str(item.description) ?? str(offered?.description);
  l.propertyType = propertyType(item, offered, l.title ?? '');
  // La recherche paramétrée porte sur la vente ; PAP ne publie que des annonces de particuliers.
  // Ces deux valeurs viennent du périmètre et de la règle de la source, pas de l'annonce (voir 0005-pap.md).
  l.transactionType = 'sale';
  l.sellerType = 'private';

  const price = num(offer?.price) ?? num(obj(offer?.priceSpecification)?.price);
  const currency = str(offer?.priceCurrency) ?? str(obj(offer?.priceSpecification)?.priceCurrency);
  if (price !== null && Number.isInteger(price) && price > 0 && currency === 'EUR') {
    l.price = price;
    l.currency = 'EUR';
  }
  const floor = obj(offered?.floorSize);
  const area = num(floor?.value);
  if (area !== null && area > 0 && (!floor?.unitCode || floor.unitCode === 'MTK')) {
    l.surfaceValue = area;
    l.surfaceKind = 'living';
  }
  const rooms = num(obj(offered?.numberOfRooms)?.value ?? offered?.numberOfRooms);
  l.rooms = rooms !== null && Number.isInteger(rooms) && rooms > 0 ? rooms : null;
  const bedrooms = num(offered?.numberOfBedrooms);
  l.bedrooms = bedrooms !== null && Number.isInteger(bedrooms) && bedrooms >= 0 ? bedrooms : null;

  const address = obj(offered?.address) ?? obj(item.address);
  l.city = str(address?.addressLocality);
  const postal = str(address?.postalCode);
  l.postalCode = postal && /^\d{5}$/.test(postal) ? postal : null;
  const geo = obj(offered?.geo) ?? obj(item.geo);
  const lat = num(geo?.latitude);
  const lng = num(geo?.longitude);
  if (lat !== null && lng !== null) {
    l.latitude = lat;
    l.longitude = lng;
  }
  // Rien n'indique une position exacte : au mieux l'échelle de la commune.
  l.locationPrecision = l.city || l.postalCode || l.latitude !== null ? 'city' : null;

  const published = str(item.datePosted) ?? str(offer?.validFrom) ?? str(item.datePublished);
  l.sourcePublishedAt = published && !Number.isNaN(Date.parse(published)) ? new Date(published).toISOString() : null;
  const modified = str(item.dateModified);
  l.sourceUpdatedAt = modified && !Number.isNaN(Date.parse(modified)) ? new Date(modified).toISOString() : null;
  return l;
}
