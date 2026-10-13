import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdemeDpeConnector, AdemeFixtureTransport } from '@imo/connectors';
import type { Db } from '@imo/db';
import { runCollection } from '@imo/domain';
import { count, FIXTURES, resetDb, setupDb } from '../helpers/db.ts';

let db: Db;
beforeAll(async () => { db = await setupDb(); });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetDb(db); });

const scope = { inseeCodes: ['06088', '78551'] };
const ademe = (dir: string) => new AdemeDpeConnector(new AdemeFixtureTransport(path.join(FIXTURES, 'ademe', dir)));
const record = async (n: string) => (await db.query('SELECT * FROM dpe_records WHERE dpe_number = $1', [n])).rows[0];

describe('import des DPE', () => {
  it('stocke les DPE du périmètre, source autorisée par sa licence ouverte', async () => {
    const run = await runCollection(db, ademe('pilote-2-pages'), scope);
    // Une ligne sans numéro rejetée : collecte partielle, identifiable.
    expect(run).toMatchObject({ status: 'partial', pagesFetched: 2, counts: { created: 6, rejected: 1 } });
    expect(await count(db, 'dpe_records')).toBe(6);
    const { rows } = await db.query("SELECT access_status, rights_note FROM sources WHERE id = 'ademe-dpe-logements'");
    expect(rows[0]).toEqual({ access_status: 'authorized', rights_note: 'Licence Ouverte / Open Licence 2.0' });
    expect(await record('2106E0680409V')).toMatchObject({ insee_code: '06088', energy_class: 'E', building_type: 'apartment' });
  });

  it('relie un DPE et celui qu’il remplace, sans fusionner', async () => {
    await runCollection(db, ademe('pilote-2-pages'), scope);
    expect(await record('2678E2536799K')).toMatchObject({ replaced_by_dpe_number: '2678E2536814Z' });
    expect(await record('2678E2536814Z')).toMatchObject({ replaces_dpe_number: '2678E2536799K', replaced_by_dpe_number: null });
  });

  it('rejouer ne crée ni doublon ni version ; une correction crée une version du même DPE', async () => {
    await runCollection(db, ademe('pilote-2-pages'), scope);
    const replay = await runCollection(db, ademe('pilote-2-pages'), scope);
    expect(replay.counts).toMatchObject({ created: 0, updated: 0, unchanged: 6 });
    expect(await count(db, 'dpe_record_versions')).toBe(6);
    expect(await count(db, 'dpe_observations')).toBe(12);

    const corrected = await runCollection(db, ademe('correction'), { ...scope, modifiedSince: '2026-10-08' });
    expect(corrected).toMatchObject({ status: 'complete', counts: { created: 0, updated: 1 } });
    expect(await count(db, 'dpe_records')).toBe(6);
    const r = await record('2606E2535225C');
    expect(r).toMatchObject({ energy_class: 'D' });
    expect(r.last_modified_at.toISOString().slice(0, 10)).toBe('2026-10-09');
    expect(await count(db, 'dpe_record_versions', 'dpe_record_id = $1', [r.id])).toBe(2);
  });

  it('un quota dépassé bloque la source sans rien écrire', async () => {
    const run = await runCollection(db, ademe('quota'), scope);
    expect(run.status).toBe('blocked');
    expect(await count(db, 'dpe_records')).toBe(0);
  });
});

describe('API DPE', () => {
  it('liste, filtre et détaille les DPE ; exclut les DPE remplacés par défaut', async () => {
    const { buildApp } = await import('@imo/web');
    await runCollection(db, ademe('pilote-2-pages'), scope);
    await runCollection(db, ademe('correction'), { ...scope, modifiedSince: '2026-10-08' });
    const app = buildApp(db);
    try {
      const all = (await app.inject('/api/dpe')).json();
      expect(all.total).toBe(5);
      expect((await app.inject('/api/dpe?includeReplaced=true')).json().total).toBe(6);
      expect((await app.inject('/api/dpe?insee=78551')).json().total).toBe(2);
      expect((await app.inject('/api/dpe?geocoded=false')).json().items.map((x: { dpeNumber: string }) => x.dpeNumber)).toEqual(['2606E2539846V']);
      const detail = (await app.inject('/api/dpe/2606e2535225c')).json();
      expect(detail).toMatchObject({ energyClass: 'D', versions: [{ data: { energyClass: 'D' } }, { data: { energyClass: 'C' } }] });
      const fresh = (await app.inject('/api/quality/dpe-freshness')).json().items;
      expect(fresh).toContainEqual(expect.objectContaining({ inseeCode: '78551', total: 3, replaced: 1, lastReceivedAt: '2026-10-05' }));
      expect((await app.inject('/')).body).toContain('DPE par commune');
    } finally {
      await app.close();
    }
  });
});
