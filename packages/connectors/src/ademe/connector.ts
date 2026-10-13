import { z } from 'zod';
import { NormalizedDpe, type Connector, type ConnectorResult } from '@imo/contracts';

type EnergyClass = NonNullable<NormalizedDpe['energyClass']>;
import { connectorError, sha256, stableStringify } from '../util.ts';
import type { AdemeTransport } from './transport.ts';

export const ADEME_SOURCE_ID = 'ademe-dpe-logements';
export const ADEME_VERSION = 'ademe-dpe@0.1.0';
export const ADEME_DATASET_URL = 'https://data.ademe.fr/data-fair/api/v1/datasets/meg-83tjwtg8dyz4vv7h1dqe';

/** Champs demandés à l'API (sur ~230) : ceux utiles à l'identification, au rapprochement et à l'affichage. */
export const ADEME_FIELDS = [
  'numero_dpe', 'numero_dpe_remplace', 'numero_dpe_immeuble_associe', 'modele_dpe', 'methode_application_dpe',
  'type_batiment', 'surface_habitable_logement', 'etiquette_dpe', 'conso_5_usages_par_m2_ep', 'etiquette_ges',
  'emission_ges_5_usages_par_m2', 'annee_construction', 'periode_construction', 'numero_etage_appartement',
  'date_visite_diagnostiqueur', 'date_etablissement_dpe', 'date_reception_dpe', 'date_derniere_modification_dpe',
  'date_fin_validite_dpe', 'adresse_ban', 'adresse_brut', 'complement_adresse_logement', 'code_postal_ban',
  'code_postal_brut', 'code_insee_ban', 'nom_commune_ban', 'identifiant_ban', 'score_ban', 'statut_geocodage',
  '_geopoint', 'id_rnb',
] as const;

export interface AdemeScope {
  /** Codes INSEE des communes (code_insee_ban), ex. 06088 pour Nice. */
  inseeCodes: string[];
  /**
   * Codes postaux saisis par le diagnostiqueur, pour rattraper les DPE mal ou non géocodés
   * (code_insee_ban absent ou différent). Optionnel.
   */
  rawPostalCodes?: string[];
  /**
   * Synchronisation incrémentale : DPE modifiés depuis cette date (YYYY-MM-DD).
   * Filtre sur date_derniere_modification_dpe et non sur la date d'établissement, pour ne pas
   * manquer les publications tardives et les corrections. Prévoir un chevauchement de quelques jours.
   */
  modifiedSince?: string;
  pageSize?: number;
}

const Num = z.union([z.number(), z.string()]).nullish();
const Str = z.union([z.string(), z.number()]).nullish();
const AdemeLine = z
  .object({
    numero_dpe: z.string(),
    numero_dpe_remplace: Str, numero_dpe_immeuble_associe: Str, modele_dpe: Str, methode_application_dpe: Str,
    type_batiment: Str, surface_habitable_logement: Num, etiquette_dpe: Str, conso_5_usages_par_m2_ep: Num,
    etiquette_ges: Str, emission_ges_5_usages_par_m2: Num, annee_construction: Num, periode_construction: Str,
    numero_etage_appartement: Num, date_visite_diagnostiqueur: Str, date_etablissement_dpe: Str,
    date_reception_dpe: Str, date_derniere_modification_dpe: Str, date_fin_validite_dpe: Str, adresse_ban: Str,
    adresse_brut: Str, complement_adresse_logement: Str, code_postal_ban: Str, code_postal_brut: Str,
    code_insee_ban: Str, nom_commune_ban: Str, identifiant_ban: Str, score_ban: Num, statut_geocodage: Str,
    _geopoint: Str, id_rnb: Str,
  })
  .passthrough();
type AdemeLine = z.infer<typeof AdemeLine>;

const AdemePage = z.object({ total: z.number().int().nonnegative(), next: z.string().url().nullish(), results: z.array(z.unknown()) }).passthrough();

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const positive = (v: unknown) => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const date = (v: unknown) => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const energy = (v: unknown): EnergyClass | null => {
  const s = str(v)?.toUpperCase();
  return s && /^[A-G]$/.test(s) ? (s as EnergyClass) : null;
};
/** Le code postal brut est parfois stocké sans zéro initial (6100 pour 06100). */
const postal = (v: unknown) => {
  const s = str(v);
  if (!s || !/^\d{4,5}$/.test(s)) return null;
  return s.padStart(5, '0');
};
const BUILDING: Record<string, NormalizedDpe['buildingType']> = { appartement: 'apartment', maison: 'house', immeuble: 'building' };

export function normalizeAdemeLine(line: AdemeLine): NormalizedDpe {
  const geo = str(line._geopoint)?.split(',').map(Number);
  const hasGeo = geo?.length === 2 && geo.every(Number.isFinite);
  const status = str(line.statut_geocodage);
  const geocodedAtAddress = status?.startsWith('adresse géocodée ban à l') ?? false;
  const year = num(line.annee_construction);
  const floor = num(line.numero_etage_appartement);
  const score = num(line.score_ban);
  return {
    sourceId: ADEME_SOURCE_ID,
    dpeNumber: line.numero_dpe.trim().toUpperCase(),
    replacesDpeNumber: str(line.numero_dpe_remplace)?.toUpperCase() ?? null,
    buildingDpeNumber: str(line.numero_dpe_immeuble_associe)?.toUpperCase() ?? null,
    dpeModel: str(line.modele_dpe),
    method: str(line.methode_application_dpe),
    buildingType: BUILDING[str(line.type_batiment)?.toLowerCase() ?? ''] ?? null,
    livingArea: positive(line.surface_habitable_logement),
    energyClass: energy(line.etiquette_dpe),
    energyValue: num(line.conso_5_usages_par_m2_ep) !== null && num(line.conso_5_usages_par_m2_ep)! >= 0 ? num(line.conso_5_usages_par_m2_ep) : null,
    gesClass: energy(line.etiquette_ges),
    gesValue: num(line.emission_ges_5_usages_par_m2) !== null && num(line.emission_ges_5_usages_par_m2)! >= 0 ? num(line.emission_ges_5_usages_par_m2) : null,
    constructionYear: year !== null && Number.isInteger(year) && year >= 1000 && year <= 2100 ? year : null,
    constructionPeriod: str(line.periode_construction),
    floor: floor !== null && Number.isInteger(floor) ? floor : null,
    visitedAt: date(line.date_visite_diagnostiqueur),
    establishedAt: date(line.date_etablissement_dpe),
    receivedAt: date(line.date_reception_dpe),
    lastModifiedAt: date(line.date_derniere_modification_dpe),
    validUntil: date(line.date_fin_validite_dpe),
    addressBan: str(line.adresse_ban),
    addressRaw: str(line.adresse_brut),
    addressComplement: str(line.complement_adresse_logement),
    postalCode: postal(line.code_postal_ban),
    rawPostalCode: postal(line.code_postal_brut),
    inseeCode: str(line.code_insee_ban)?.padStart(5, '0') ?? null,
    city: str(line.nom_commune_ban),
    banId: str(line.identifiant_ban),
    banScore: score !== null && score >= 0 && score <= 1 ? score : null,
    geocodingStatus: status,
    latitude: hasGeo ? geo![0]! : null,
    longitude: hasGeo ? geo![1]! : null,
    // Géocodé à l'adresse : précision du numéro de voie (pas du logement). Sinon on ne présume rien.
    locationPrecision: hasGeo ? (geocodedAtAddress ? 'exact' : null) : null,
    rnbId: str(line.id_rnb),
  };
}

export function buildAdemeQuery(scope: AdemeScope): string {
  const insee = scope.inseeCodes.map((c) => c.trim()).filter(Boolean);
  const raw = (scope.rawPostalCodes ?? []).map((c) => c.trim().replace(/^0/, '')).filter(Boolean);
  const parts = [];
  if (insee.length) parts.push(`code_insee_ban:(${insee.join(' OR ')})`);
  if (raw.length) parts.push(`code_postal_brut:(${raw.join(' OR ')})`);
  if (!parts.length) throw new Error('périmètre ADEME vide : au moins un code INSEE ou postal');
  let qs = parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0]!;
  if (scope.modifiedSince) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scope.modifiedSince)) throw new Error(`modifiedSince invalide : ${scope.modifiedSince}`);
    qs += ` AND date_derniere_modification_dpe:>=${scope.modifiedSince}`;
  }
  return qs;
}

export function firstPageUrl(scope: AdemeScope): string {
  const params = new URLSearchParams({
    qs: buildAdemeQuery(scope),
    size: String(scope.pageSize ?? 1000),
    select: ADEME_FIELDS.join(','),
    sort: '_i',
  });
  return `${ADEME_DATASET_URL}/lines?${params.toString()}`;
}

export class AdemeDpeConnector implements Connector<AdemeScope> {
  readonly source = { id: ADEME_SOURCE_ID, name: 'ADEME · DPE logements existants', kind: 'public_data' as const, openLicence: 'Licence Ouverte / Open Licence 2.0' };
  readonly version = ADEME_VERSION;
  readonly capabilities = { detail: false, requiresAuthorizedAccess: false };

  constructor(private readonly transport: AdemeTransport) {}

  scopeKey(scope: AdemeScope): string {
    const raw = [...(scope.rawPostalCodes ?? [])].sort().join(',');
    return `ademe:${[...scope.inseeCodes].sort().join(',')}${raw ? `+cp:${raw}` : ''}`;
  }

  /** Une extraction complète (sans filtre de date) couvre tout le périmètre ; une synchronisation incrémentale non. */
  async exhaustive(scope: AdemeScope): Promise<boolean> {
    return !scope.modifiedSince;
  }

  async runKey(): Promise<null> {
    return null;
  }

  async observedAt(): Promise<null> {
    return null;
  }

  async health() {
    return { ok: true, detail: 'API publique data-fair ADEME' };
  }

  async discover(scope: AdemeScope, cursor: string | null, page: number): Promise<ConnectorResult> {
    const result: ConnectorResult = {
      status: 'ok', listings: [], dpeRecords: [], raw: {}, rejected: [], errors: [], page, pagesExpected: null, nextCursor: null, truncated: false,
    };
    let res;
    try {
      res = await this.transport.get(cursor ?? firstPageUrl(scope));
    } catch (err) {
      return { ...result, status: 'failed', nextCursor: cursor, errors: [connectorError('network', (err as Error).message, page)] };
    }
    if (res.status === 429) return { ...result, status: 'blocked', nextCursor: cursor, errors: [connectorError('rate_limited', 'HTTP 429 : quota de l’API ADEME atteint', page)] };
    if (res.status === 401 || res.status === 403) return { ...result, status: 'blocked', nextCursor: cursor, errors: [connectorError('forbidden', `HTTP ${res.status}`, page)] };
    if (res.status >= 400) return { ...result, status: 'failed', nextCursor: cursor, errors: [connectorError('http', `HTTP ${res.status}`, page)] };

    const parsed = AdemePage.safeParse(res.body);
    if (!parsed.success) {
      return { ...result, status: 'failed', nextCursor: cursor, errors: [connectorError('unexpected_schema', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), page)] };
    }
    const size = scope.pageSize ?? 1000;
    result.pagesExpected = Math.ceil(parsed.data.total / size);
    for (const [i, raw] of parsed.data.results.entries()) {
      const line = AdemeLine.safeParse(raw);
      const ref = line.success ? line.data.numero_dpe : `page${page}#${i}`;
      const dpe = line.success ? NormalizedDpe.safeParse(normalizeAdemeLine(line.data)) : null;
      if (!line.success || !dpe?.success) {
        const issues = (line.success ? dpe!.error! : line.error).issues;
        result.rejected.push({ itemRef: ref, errors: issues.map((x) => `${x.path.join('.')}: ${x.message}`) });
        continue;
      }
      result.dpeRecords!.push(dpe.data);
      result.raw[dpe.data.dpeNumber] = { hash: sha256(stableStringify(raw)), excerpt: null };
    }
    const next = parsed.data.next;
    result.nextCursor = next && parsed.data.results.length > 0 && next !== cursor ? next : null;
    return result;
  }
}
