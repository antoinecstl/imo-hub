import { createHash } from 'node:crypto';
import { LISTING_CONTENT_FIELDS, type NormalizedListing } from '@imo/contracts';
import type { DbClient } from '@imo/db';

export type IngestOutcome = 'created' | 'updated' | 'unchanged' | 'duplicate_in_run';

export interface IngestContext {
  runId: string;
  scopeKey: string;
  observedAt: Date;
  parserVersion: string;
}

export function contentHash(listing: NormalizedListing): string {
  const content = LISTING_CONTENT_FIELDS.map((f) => [f, listing[f]]);
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

interface ListingRow {
  id: string;
  last_seen_at: Date;
  presence_status: 'seen' | 'not_seen';
  current_hash: string;
  current_data: NormalizedListing;
}

const CURRENT_COLUMNS = `source_url = $2, transaction_type = $3, property_type = $4, seller_type = $5, title = $6,
  price = $7, surface_value = $8, rooms = $9, city = $10, postal_code = $11, energy_class = $12,
  location = CASE WHEN $13::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($14::float8, $13::float8), 4326)::geography END,
  source_published_at = $15`;

function currentValues(l: NormalizedListing): unknown[] {
  return [
    l.sourceUrl, l.transactionType, l.propertyType, l.sellerType, l.title, l.price, l.surfaceValue, l.rooms,
    l.city, l.postalCode, l.energyClass, l.latitude, l.longitude, l.sourcePublishedAt,
  ];
}

async function insertSnapshot(c: DbClient, listingId: string, l: NormalizedListing, hash: string, ctx: IngestContext): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO listing_snapshots (listing_id, run_id, content_hash, data, parser_version, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [listingId, ctx.runId, hash, JSON.stringify(l), ctx.parserVersion, ctx.observedAt],
  );
  return rows[0]!.id;
}

async function insertEvent(c: DbClient, listingId: string, kind: string, ctx: IngestContext, payload: object = {}) {
  await c.query(
    `INSERT INTO listing_events (listing_id, run_id, kind, observed_at, payload) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (listing_id, run_id, kind) DO NOTHING`,
    [listingId, ctx.runId, kind, ctx.observedAt, JSON.stringify(payload)],
  );
}

/**
 * Enregistre une annonce observée dans une collecte :
 * - une annonce par (source, identifiant externe) ;
 * - une observation par collecte (rejouer la même page ne duplique rien) ;
 * - un nouveau snapshot seulement si le contenu a changé ;
 * - les événements ne sont émis que pour l'observation la plus récente.
 */
export async function ingestListing(c: DbClient, l: NormalizedListing, rawHash: string, ctx: IngestContext): Promise<IngestOutcome> {
  const hash = contentHash(l);
  const existing = await c.query<ListingRow>(
    `SELECT l.id, l.last_seen_at, l.presence_status, s.content_hash AS current_hash, s.data AS current_data
       FROM listings l JOIN listing_snapshots s ON s.id = l.current_snapshot_id
      WHERE l.source_id = $1 AND l.external_id = $2 FOR UPDATE OF l`,
    [l.sourceId, l.externalId],
  );

  if (existing.rowCount === 0) {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO listings (source_id, external_id, scope_key, first_seen_at, last_seen_at, last_seen_run_id)
       VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`,
      [l.sourceId, l.externalId, ctx.scopeKey, ctx.observedAt, ctx.runId],
    );
    const listingId = rows[0]!.id;
    const snapshotId = await insertSnapshot(c, listingId, l, hash, ctx);
    await c.query(`UPDATE listings SET current_snapshot_id = $16, ${CURRENT_COLUMNS} WHERE id = $1`, [listingId, ...currentValues(l), snapshotId]);
    await c.query(
      `INSERT INTO listing_observations (listing_id, run_id, snapshot_id, observed_at, raw_hash) VALUES ($1, $2, $3, $4, $5)`,
      [listingId, ctx.runId, snapshotId, ctx.observedAt, rawHash],
    );
    await insertEvent(c, listingId, 'appeared', ctx, { price: l.price });
    return 'created';
  }

  const row = existing.rows[0]!;
  const already = await c.query('SELECT 1 FROM listing_observations WHERE listing_id = $1 AND run_id = $2', [row.id, ctx.runId]);
  if (already.rowCount) return 'duplicate_in_run';

  const isLatest = ctx.observedAt.getTime() >= row.last_seen_at.getTime();
  const changed = hash !== row.current_hash;
  let snapshotId: string | null = null;
  if (changed) snapshotId = await insertSnapshot(c, row.id, l, hash, ctx);

  if (isLatest) {
    if (changed) {
      const before = row.current_data;
      if (before.price !== l.price) await insertEvent(c, row.id, 'price_changed', ctx, { from: before.price, to: l.price });
      const otherChanges = LISTING_CONTENT_FIELDS.filter((f) => f !== 'price' && f !== 'currency' && before[f] !== l[f]);
      if (otherChanges.length) await insertEvent(c, row.id, 'modified', ctx, { fields: otherChanges });
      await c.query(`UPDATE listings SET current_snapshot_id = $16, ${CURRENT_COLUMNS} WHERE id = $1`, [row.id, ...currentValues(l), snapshotId]);
    }
    if (row.presence_status === 'not_seen') await insertEvent(c, row.id, 'reappeared', ctx);
    await c.query(
      `UPDATE listings SET last_seen_at = $2, last_seen_run_id = $3, scope_key = $4, presence_status = 'seen',
              missed_complete_runs = 0, updated_at = now() WHERE id = $1`,
      [row.id, ctx.observedAt, ctx.runId, ctx.scopeKey],
    );
  }

  // Une observation plus ancienne que l'état courant enrichit l'historique sans le réécrire.
  const obsSnapshot = snapshotId ?? (await c.query<{ current_snapshot_id: string }>('SELECT current_snapshot_id FROM listings WHERE id = $1', [row.id])).rows[0]!.current_snapshot_id;
  await c.query(
    `INSERT INTO listing_observations (listing_id, run_id, snapshot_id, observed_at, raw_hash) VALUES ($1, $2, $3, $4, $5)`,
    [row.id, ctx.runId, obsSnapshot, ctx.observedAt, rawHash],
  );
  return isLatest && changed ? 'updated' : 'unchanged';
}
