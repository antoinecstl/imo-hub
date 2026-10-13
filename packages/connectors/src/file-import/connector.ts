import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import { z } from 'zod';
import { emptyListing, NormalizedListing } from '@imo/contracts';
import type { Connector, ConnectorResult } from '@imo/contracts';
import { connectorError, sha256, stableStringify } from '../util.ts';

/**
 * Import d'un fichier CSV ou JSON d'annonces, fourni dans un cadre autorisé
 * (export d'un partenaire, saisie de l'agence, flux dégradé).
 *
 * Colonnes reconnues (snake_case) : external_id (obligatoire), source_url, transaction_type,
 * property_type, seller_type, title, description, price, currency, surface_value, surface_kind,
 * land_surface, rooms, bedrooms, city, postal_code, insee_code, address_text, latitude, longitude,
 * location_precision, energy_class, energy_value, ges_class, ges_value, dpe_number,
 * source_published_at, source_updated_at. Une cellule vide signifie « inconnu ».
 *
 * JSON accepté : un tableau de lignes, ou { observed_at?, exhaustive?, listings: [...] }.
 */
export const FILE_IMPORT_VERSION = 'file-import@0.1.0';

export interface FileImportScope {
  filePath: string;
  /** Identifiant de la source décrite par le fichier (ex. « import-agence-pilote »). */
  sourceId: string;
  sourceName?: string;
  /** Date d'extraction des données ; à défaut, celle du fichier JSON ; à défaut, l'heure d'import. */
  observedAt?: string;
  /** Le fichier décrit-il TOUTES les annonces du périmètre à cette date ? */
  exhaustive?: boolean;
}

const COLUMN_TO_FIELD: Record<string, keyof NormalizedListing> = {
  source_url: 'sourceUrl', transaction_type: 'transactionType', property_type: 'propertyType',
  seller_type: 'sellerType', title: 'title', description: 'description', price: 'price', currency: 'currency',
  surface_value: 'surfaceValue', surface_kind: 'surfaceKind', land_surface: 'landSurface', rooms: 'rooms',
  bedrooms: 'bedrooms', city: 'city', postal_code: 'postalCode', insee_code: 'inseeCode',
  address_text: 'addressText', latitude: 'latitude', longitude: 'longitude', location_precision: 'locationPrecision',
  energy_class: 'energyClass', energy_value: 'energyValue', ges_class: 'gesClass', ges_value: 'gesValue',
  dpe_number: 'dpeNumber', source_published_at: 'sourcePublishedAt', source_updated_at: 'sourceUpdatedAt',
};
const NUMERIC_FIELDS = new Set<keyof NormalizedListing>([
  'price', 'surfaceValue', 'landSurface', 'rooms', 'bedrooms', 'latitude', 'longitude', 'energyValue', 'gesValue',
]);
const UPPER_FIELDS = new Set<keyof NormalizedListing>(['energyClass', 'gesClass', 'currency']);

const JsonEnvelope = z.object({
  observed_at: z.string().datetime({ offset: true }).optional(),
  exhaustive: z.boolean().optional(),
  listings: z.array(z.record(z.unknown())),
});

interface ParsedFile {
  rows: Record<string, unknown>[];
  /** Numéro de ligne d'origine (CSV : ligne du fichier ; JSON : index + 1). */
  lineOf: (index: number) => number;
  observedAt: string | null;
  exhaustive: boolean | null;
  hash: string;
}

async function load(filePath: string): Promise<ParsedFile> {
  const content = await readFile(filePath);
  const hash = sha256(content);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') {
    const rows = parseCsv(content, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[];
    return { rows, lineOf: (i) => i + 2, observedAt: null, exhaustive: null, hash };
  }
  if (ext === '.json') {
    const data: unknown = JSON.parse(content.toString('utf8'));
    if (Array.isArray(data)) return { rows: data as Record<string, unknown>[], lineOf: (i) => i + 1, observedAt: null, exhaustive: null, hash };
    const env = JsonEnvelope.parse(data);
    return { rows: env.listings, lineOf: (i) => i + 1, observedAt: env.observed_at ?? null, exhaustive: env.exhaustive ?? null, hash };
  }
  throw new Error(`format non pris en charge : ${ext} (attendu .csv ou .json)`);
}

function toListing(sourceId: string, row: Record<string, unknown>): unknown {
  const externalId = row.external_id === undefined || row.external_id === null ? '' : String(row.external_id).trim();
  // Un external_id vide sera rejeté par la validation du contrat.
  const listing: Record<string, unknown> = emptyListing(sourceId, externalId);
  for (const [column, field] of Object.entries(COLUMN_TO_FIELD)) {
    let value = row[column];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) continue;
    if (typeof value === 'string') value = value.trim();
    if (NUMERIC_FIELDS.has(field) && typeof value === 'string') {
      const n = Number(value.replace(',', '.'));
      value = Number.isFinite(n) ? n : value; // une valeur illisible reste telle quelle et sera rejetée
    }
    if (UPPER_FIELDS.has(field) && typeof value === 'string') value = value.toUpperCase();
    listing[field] = value;
  }
  // Colonnes inconnues : signalées, jamais devinées.
  const unknown = Object.keys(row).filter((c) => c !== 'external_id' && !(c in COLUMN_TO_FIELD));
  if (unknown.length) listing.__unknownColumns = unknown;
  return listing;
}

export class FileImportConnector implements Connector<FileImportScope> {
  readonly version = FILE_IMPORT_VERSION;
  readonly capabilities = { detail: false, requiresAuthorizedAccess: false };
  readonly source;

  constructor(scope: Pick<FileImportScope, 'sourceId' | 'sourceName'>) {
    this.source = { id: scope.sourceId, name: scope.sourceName ?? scope.sourceId, kind: 'file_import' as const };
  }

  scopeKey(scope: FileImportScope): string {
    return `file:${scope.sourceId}`;
  }

  async exhaustive(scope: FileImportScope): Promise<boolean> {
    return scope.exhaustive ?? (await load(scope.filePath)).exhaustive ?? false;
  }

  async runKey(scope: FileImportScope): Promise<string> {
    return `sha256:${(await load(scope.filePath)).hash}`;
  }

  async observedAt(scope: FileImportScope): Promise<Date | null> {
    const value = scope.observedAt ?? (await load(scope.filePath)).observedAt;
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new Error(`date d'observation illisible : ${value}`);
    return d;
  }

  async health() {
    return { ok: true, detail: 'import de fichier local' };
  }

  async discover(scope: FileImportScope, _cursor: string | null, page: number): Promise<ConnectorResult> {
    const result: ConnectorResult = {
      status: 'ok', listings: [], raw: {}, rejected: [], errors: [], page, pagesExpected: 1, nextCursor: null, truncated: false,
    };
    let file: ParsedFile;
    try {
      file = await load(scope.filePath);
    } catch (err) {
      return { ...result, status: 'failed', errors: [connectorError('unexpected_schema', (err as Error).message, page)] };
    }
    const seen = new Set<string>();
    file.rows.forEach((row, i) => {
      const ref = `ligne ${file.lineOf(i)}`;
      const candidate = toListing(scope.sourceId, row) as Record<string, unknown>;
      const unknownColumns = candidate.__unknownColumns as string[] | undefined;
      delete candidate.__unknownColumns;
      const parsed = NormalizedListing.safeParse(candidate);
      if (!parsed.success) {
        result.rejected.push({ itemRef: ref, errors: parsed.error.issues.map((x) => `${x.path.join('.') || '(ligne)'}: ${x.message}`) });
        return;
      }
      if (seen.has(parsed.data.externalId)) {
        result.rejected.push({ itemRef: ref, errors: [`external_id ${parsed.data.externalId} déjà présent dans le fichier`] });
        return;
      }
      seen.add(parsed.data.externalId);
      if (unknownColumns && i === 0) {
        result.errors.push(connectorError('unexpected_schema', `colonnes ignorées : ${unknownColumns.join(', ')}`, page));
      }
      result.listings.push(parsed.data);
      result.raw[parsed.data.externalId] = { hash: sha256(stableStringify(row)), excerpt: null };
    });
    return result;
  }
}
