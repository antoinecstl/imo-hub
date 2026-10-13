import { createPool, migrate, type Db } from '@imo/db';

export { FIXTURES } from './fixtures.ts';

export async function setupDb(): Promise<Db> {
  const db = createPool();
  await migrate(db);
  return db;
}

export async function resetDb(db: Db) {
  await db.query('TRUNCATE dpe_observations, dpe_records, dpe_record_versions, listing_events, listing_observations, listings, listing_snapshots, collection_runs, sources RESTART IDENTITY CASCADE');
}

export async function count(db: Db, table: string, where = 'true', params: unknown[] = []): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return rows[0]!.n;
}
