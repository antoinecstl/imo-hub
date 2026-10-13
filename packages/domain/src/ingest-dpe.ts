import { createHash } from 'node:crypto';
import { DPE_CONTENT_FIELDS, type NormalizedDpe } from '@imo/contracts';
import type { DbClient } from '@imo/db';
import type { IngestContext, IngestOutcome } from './ingest.ts';

export function dpeContentHash(d: NormalizedDpe): string {
  return createHash('sha256').update(JSON.stringify(DPE_CONTENT_FIELDS.map((f) => [f, d[f]]))).digest('hex');
}

const CURRENT = `replaces_dpe_number = $2, building_type = $3, living_area = $4, energy_class = $5, ges_class = $6,
  established_at = $7, received_at = $8, last_modified_at = $9, insee_code = $10, postal_code = $11,
  raw_postal_code = $12, address_ban = $13, geocoding_status = $14,
  location = CASE WHEN $15::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($16::float8, $15::float8), 4326)::geography END`;

const currentValues = (d: NormalizedDpe) => [
  d.replacesDpeNumber, d.buildingType, d.livingArea, d.energyClass, d.gesClass, d.establishedAt, d.receivedAt,
  d.lastModifiedAt, d.inseeCode, d.postalCode, d.rawPostalCode, d.addressBan, d.geocodingStatus, d.latitude, d.longitude,
];

async function insertVersion(c: DbClient, recordId: string, d: NormalizedDpe, hash: string, ctx: IngestContext) {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO dpe_record_versions (dpe_record_id, run_id, content_hash, data, parser_version, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [recordId, ctx.runId, hash, JSON.stringify(d), ctx.parserVersion, ctx.observedAt],
  );
  return rows[0]!.id;
}

/**
 * Enregistre un DPE : un enregistrement par numéro, une nouvelle version quand l'ADEME publie
 * une correction (contenu différent), et le lien de remplacement dans les deux sens.
 * Une correction technique ne crée jamais un nouveau DPE.
 */
export async function ingestDpe(c: DbClient, d: NormalizedDpe, rawHash: string, ctx: IngestContext): Promise<IngestOutcome> {
  const hash = dpeContentHash(d);
  const existing = await c.query<{ id: string; current_hash: string; last_seen_at: Date }>(
    `SELECT r.id, v.content_hash AS current_hash, r.last_seen_at
       FROM dpe_records r JOIN dpe_record_versions v ON v.id = r.current_version_id
      WHERE r.source_id = $1 AND r.dpe_number = $2 FOR UPDATE OF r`,
    [d.sourceId, d.dpeNumber],
  );

  let recordId: string;
  let versionId: string;
  let outcome: IngestOutcome;
  if (existing.rowCount === 0) {
    const replacedBy = await c.query<{ dpe_number: string }>(
      'SELECT dpe_number FROM dpe_records WHERE source_id = $1 AND replaces_dpe_number = $2 LIMIT 1',
      [d.sourceId, d.dpeNumber],
    );
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO dpe_records (source_id, dpe_number, first_seen_at, last_seen_at, last_seen_run_id, replaced_by_dpe_number)
       VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
      [d.sourceId, d.dpeNumber, ctx.observedAt, ctx.runId, replacedBy.rows[0]?.dpe_number ?? null],
    );
    recordId = rows[0]!.id;
    versionId = await insertVersion(c, recordId, d, hash, ctx);
    await c.query(`UPDATE dpe_records SET current_version_id = $17, ${CURRENT} WHERE id = $1`, [recordId, ...currentValues(d), versionId]);
    outcome = 'created';
  } else {
    const row = existing.rows[0]!;
    recordId = row.id;
    const already = await c.query('SELECT 1 FROM dpe_observations WHERE dpe_record_id = $1 AND run_id = $2', [recordId, ctx.runId]);
    if (already.rowCount) return 'duplicate_in_run';
    const isLatest = ctx.observedAt.getTime() >= row.last_seen_at.getTime();
    if (hash !== row.current_hash) {
      versionId = await insertVersion(c, recordId, d, hash, ctx);
      if (isLatest) {
        await c.query(`UPDATE dpe_records SET current_version_id = $17, ${CURRENT}, updated_at = now() WHERE id = $1`, [recordId, ...currentValues(d), versionId]);
      }
      outcome = isLatest ? 'updated' : 'unchanged';
    } else {
      versionId = (await c.query<{ current_version_id: string }>('SELECT current_version_id FROM dpe_records WHERE id = $1', [recordId])).rows[0]!.current_version_id;
      outcome = 'unchanged';
    }
    if (isLatest) {
      await c.query('UPDATE dpe_records SET last_seen_at = $2, last_seen_run_id = $3 WHERE id = $1', [recordId, ctx.observedAt, ctx.runId]);
    }
  }

  if (d.replacesDpeNumber) {
    await c.query(
      `UPDATE dpe_records SET replaced_by_dpe_number = $3, updated_at = now()
        WHERE source_id = $1 AND dpe_number = $2 AND replaced_by_dpe_number IS DISTINCT FROM $3`,
      [d.sourceId, d.replacesDpeNumber, d.dpeNumber],
    );
  }
  await c.query(
    'INSERT INTO dpe_observations (dpe_record_id, run_id, version_id, observed_at, raw_hash) VALUES ($1, $2, $3, $4, $5)',
    [recordId, ctx.runId, versionId, ctx.observedAt, rawHash],
  );
  return outcome;
}
