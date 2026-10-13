import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FileImportConnector, FixtureTransport, LeboncoinConnector, PapConnector, PapFixtureTransport } from '@imo/connectors';
import type { Db } from '@imo/db';
import { runCollection, runSources } from '@imo/domain';
import { count, FIXTURES, resetDb, setupDb } from '../helpers/db.ts';

let db: Db;
beforeAll(async () => { db = await setupDb(); });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetDb(db); });

const papScope = {
  searchUrls: [
    'https://www.pap.fr/annonce/vente-immobiliere-nice-06-fixture',
    'https://www.pap.fr/annonce/vente-immobiliere-saint-germain-en-laye-78-fixture',
  ],
};
const pap = (dir: string) => new PapConnector(new PapFixtureTransport(path.join(FIXTURES, 'pap', dir)));
const lbc = (dir: string) => new LeboncoinConnector(new FixtureTransport(path.join(FIXTURES, 'leboncoin', dir)));

describe('plusieurs sources d’annonces', () => {
  it('PAP : collecte, rejeu sans doublon et baisse de prix', async () => {
    const first = await runCollection(db, pap('pilote'), papScope);
    expect(first).toMatchObject({ status: 'complete', pagesFetched: 3, counts: { seen: 6, created: 6 } });
    const replay = await runCollection(db, pap('pilote'), papScope);
    expect(replay.counts).toMatchObject({ created: 0, unchanged: 6 });
    await runCollection(db, pap('prix-baisse'), papScope);
    expect(await count(db, 'listings', "source_id = 'pap'")).toBe(6);
    expect(await count(db, 'listing_events', "kind = 'price_changed'")).toBe(1);
  });

  it('une interruption PAP entre deux communes se reprend sans doublon', async () => {
    let calls = 0;
    const transport = new PapFixtureTransport(path.join(FIXTURES, 'pap', 'pilote'));
    const flaky = { live: false, get: (url: string) => (++calls === 3 ? Promise.reject(new Error('ECONNRESET')) : transport.get(url)) };
    const partial = await runCollection(db, new PapConnector(flaky), papScope, { retries: 0 });
    expect(partial).toMatchObject({ status: 'partial', pagesFetched: 2 });
    const resumed = await runCollection(db, pap('pilote'), papScope, { resumeRunId: partial.runId });
    expect(resumed).toMatchObject({ status: 'complete', pagesFetched: 3, counts: { seen: 6 } });
    expect(await count(db, 'listings')).toBe(6);
  });

  it('trois sources coexistent ; un blocage PAP ne touche ni Leboncoin ni l’import', async () => {
    const file = { filePath: path.join(FIXTURES, 'import', 'annonces-pilote-2026-10-13.csv'), sourceId: 'import-agence', observedAt: '2026-10-13T07:00:00+02:00' };
    await runSources(db, [
      { connector: pap('pilote'), scope: papScope },
      { connector: lbc('vannes-3-pages'), scope: { locations: ['56000'] } },
      { connector: new FileImportConnector(file), scope: file },
    ]);
    const results = await runSources(db, [
      { connector: pap('anomalies'), scope: { searchUrls: ['https://www.pap.fr/challenge'] } },
      { connector: lbc('vannes-3-pages'), scope: { locations: ['56000'] } },
    ]);
    expect(results.map((r) => r.status)).toEqual(['blocked', 'complete']);
    const { rows } = await db.query<{ source_id: string; n: number }>('SELECT source_id, count(*)::int AS n FROM listings GROUP BY source_id ORDER BY source_id');
    expect(rows).toEqual([{ source_id: 'import-agence', n: 4 }, { source_id: 'leboncoin', n: 6 }, { source_id: 'pap', n: 6 }]);
    expect(await count(db, 'listings', "presence_status <> 'seen'")).toBe(0);
  });
});
