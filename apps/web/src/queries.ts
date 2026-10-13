import { z } from 'zod';
import type { Db } from '@imo/db';

export const ListingsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  source: z.string().optional(),
  postalCode: z.string().regex(/^\d{5}$/).optional(),
  city: z.string().optional(),
  transactionType: z.enum(['sale', 'rent']).optional(),
  propertyType: z.enum(['house', 'apartment', 'land', 'parking', 'other']).optional(),
  sellerType: z.enum(['private', 'professional']).optional(),
  minPrice: z.coerce.number().int().optional(),
  maxPrice: z.coerce.number().int().optional(),
  presence: z.enum(['seen', 'not_seen']).optional(),
  seenSince: z.string().datetime({ offset: true }).optional(),
  // Recherche par rayon autour d'un point (PostGIS).
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusM: z.coerce.number().positive().max(100_000).optional(),
});
export type ListingsQuery = z.infer<typeof ListingsQuery>;

const LISTING_COLUMNS = `l.id, l.source_id AS "sourceId", l.external_id AS "externalId", l.source_url AS "sourceUrl",
  l.transaction_type AS "transactionType", l.property_type AS "propertyType", l.seller_type AS "sellerType",
  l.title, l.price, l.surface_value AS "surfaceValue", l.rooms, l.city, l.postal_code AS "postalCode",
  l.energy_class AS "energyClass", ST_Y(l.location::geometry) AS latitude, ST_X(l.location::geometry) AS longitude,
  l.presence_status AS "presenceStatus", l.source_published_at AS "sourcePublishedAt",
  l.first_seen_at AS "firstSeenAt", l.last_seen_at AS "lastSeenAt"`;

export async function listListings(db: Db, q: ListingsQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (q.source) add('l.source_id = ?', q.source);
  if (q.postalCode) add('l.postal_code = ?', q.postalCode);
  if (q.city) add('lower(l.city) = lower(?)', q.city);
  if (q.transactionType) add('l.transaction_type = ?', q.transactionType);
  if (q.propertyType) add('l.property_type = ?', q.propertyType);
  if (q.sellerType) add('l.seller_type = ?', q.sellerType);
  if (q.minPrice !== undefined) add('l.price >= ?', q.minPrice);
  if (q.maxPrice !== undefined) add('l.price <= ?', q.maxPrice);
  if (q.presence) add('l.presence_status = ?', q.presence);
  if (q.seenSince) add('l.last_seen_at >= ?', q.seenSince);
  if (q.lat !== undefined && q.lng !== undefined && q.radiusM !== undefined) {
    params.push(q.lng, q.lat, q.radiusM);
    const n = params.length;
    where.push(`ST_DWithin(l.location, ST_SetSRID(ST_MakePoint($${n - 2}, $${n - 1}), 4326)::geography, $${n})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM listings l ${whereSql}`, params);
  const offset = (q.page - 1) * q.pageSize;
  const { rows } = await db.query(
    `SELECT ${LISTING_COLUMNS} FROM listings l ${whereSql}
      ORDER BY l.last_seen_at DESC, l.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, q.pageSize, offset],
  );
  const totalCount = total.rows[0]!.n;
  return { items: rows, page: q.page, pageSize: q.pageSize, total: totalCount, totalPages: Math.ceil(totalCount / q.pageSize) };
}

export async function getListing(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT ${LISTING_COLUMNS}, l.missed_complete_runs AS "missedCompleteRuns", s.data AS current
       FROM listings l JOIN listing_snapshots s ON s.id = l.current_snapshot_id WHERE l.id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  const [snapshots, events, observations] = await Promise.all([
    db.query(`SELECT id, run_id AS "runId", observed_at AS "observedAt", parser_version AS "parserVersion", data
                FROM listing_snapshots WHERE listing_id = $1 ORDER BY observed_at DESC, created_at DESC`, [id]),
    db.query(`SELECT kind, observed_at AS "observedAt", run_id AS "runId", payload
                FROM listing_events WHERE listing_id = $1 ORDER BY observed_at DESC, kind`, [id]),
    db.query(`SELECT o.run_id AS "runId", o.observed_at AS "observedAt", r.status AS "runStatus"
                FROM listing_observations o JOIN collection_runs r ON r.id = o.run_id
               WHERE o.listing_id = $1 ORDER BY o.observed_at DESC`, [id]),
  ]);
  return { ...rows[0], snapshots: snapshots.rows, events: events.rows, observations: observations.rows };
}

const RUN_COLUMNS = `id, source_id AS "sourceId", scope_key AS "scopeKey", status, exhaustive, observed_at AS "observedAt",
  started_at AS "startedAt", finished_at AS "finishedAt", pages_expected AS "pagesExpected", pages_fetched AS "pagesFetched",
  items_seen AS "seen", items_created AS "created", items_updated AS "updated", items_unchanged AS "unchanged",
  items_rejected AS "rejected", errors, rejected AS "rejectedItems", block_reason AS "blockReason"`;

export async function listRuns(db: Db, opts: { source?: string; limit?: number }) {
  const { rows } = await db.query(
    `SELECT ${RUN_COLUMNS} FROM collection_runs WHERE ($1::text IS NULL OR source_id = $1) ORDER BY started_at DESC LIMIT $2`,
    [opts.source ?? null, opts.limit ?? 50],
  );
  return rows;
}

export async function listSources(db: Db) {
  const { rows } = await db.query(
    `SELECT s.id, s.name, s.kind, s.enabled, s.access_status AS "accessStatus", s.connector_version AS "connectorVersion",
            (SELECT count(*)::int FROM listings l WHERE l.source_id = s.id) AS "listingCount",
            (SELECT max(l.last_seen_at) FROM listings l WHERE l.source_id = s.id) AS "lastSeenAt",
            (SELECT row_to_json(r) FROM (SELECT ${RUN_COLUMNS} FROM collection_runs WHERE source_id = s.id ORDER BY started_at DESC LIMIT 1) r) AS "lastRun"
       FROM sources s ORDER BY s.id`,
  );
  return rows;
}

/** Part des annonces (dans leur état courant) qui renseignent chaque champ. */
export async function fieldCompleteness(db: Db) {
  const { rows } = await db.query<{ source_id: string; field: string; filled: number; total: number }>(
    `SELECT l.source_id, kv.key AS field, count(*) FILTER (WHERE kv.value <> 'null'::jsonb)::int AS filled, count(*)::int AS total
       FROM listings l JOIN listing_snapshots s ON s.id = l.current_snapshot_id, jsonb_each(s.data) kv
      WHERE kv.key NOT IN ('sourceId', 'externalId')
      GROUP BY l.source_id, kv.key ORDER BY l.source_id, kv.key`,
  );
  return rows;
}
