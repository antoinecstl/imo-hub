import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Connector, ConnectorResult } from '@imo/contracts';
import { FileImportConnector, FixtureTransport, LeboncoinConnector, type LbcScope } from '@imo/connectors';
import type { Db } from '@imo/db';
import { runCollection, runSources } from '@imo/domain';
import { count, FIXTURES, resetDb, setupDb } from '../helpers/db.ts';

let db: Db;
beforeAll(async () => { db = await setupDb(); });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetDb(db); });

const lbcScope: LbcScope = { locations: ['56000', '56860'] };
const lbc = (dir: string) => new LeboncoinConnector(new FixtureTransport(path.join(FIXTURES, 'leboncoin', dir)));
const noWait = { sleep: async () => {}, retryBaseDelayMs: 0 };
const csv = (name: string, observedAt: string, extra: { exhaustive?: boolean } = {}) => {
  const scope = { filePath: path.join(FIXTURES, 'import', name), sourceId: 'import-agence', observedAt, ...extra };
  return { connector: new FileImportConnector(scope), scope };
};
const listing = async (sourceId: string, externalId: string) =>
  (await db.query('SELECT * FROM listings WHERE source_id = $1 AND external_id = $2', [sourceId, externalId])).rows[0];

/** Enveloppe un connecteur pour simuler des pannes à des pages données. */
function flaky<S>(inner: Connector<S>, failOnPages: Set<number>, kind: 'network' | 'challenge' = 'network'): Connector<S> {
  return {
    source: inner.source, version: inner.version, capabilities: inner.capabilities,
    scopeKey: (s) => inner.scopeKey(s), exhaustive: (s) => inner.exhaustive(s), runKey: (s) => inner.runKey(s),
    observedAt: (s) => inner.observedAt(s), health: () => inner.health(),
    async discover(scope, cursor, page): Promise<ConnectorResult> {
      if (failOnPages.has(page)) {
        return {
          status: kind === 'network' ? 'failed' : 'blocked', listings: [], raw: {}, rejected: [], page, pagesExpected: null,
          nextCursor: cursor, truncated: false,
          errors: [{ kind, message: `panne simulée page ${page}`, page, itemRef: null, at: new Date().toISOString() }],
        };
      }
      return inner.discover(scope, cursor, page);
    },
  };
}

describe('pipeline d’ingestion', () => {
  it('donnée source → observation → normalisation → stockage', async () => {
    const { connector, scope } = csv('annonces-pilote-2026-10-13.csv', '2026-10-13T07:00:00+02:00');
    const run = await runCollection(db, connector, scope);
    expect(run.status).toBe('complete');
    expect(run.counts).toMatchObject({ seen: 4, created: 4, rejected: 0 });
    expect(await count(db, 'listings')).toBe(4);
    expect(await count(db, 'listing_observations')).toBe(4);
    expect(await count(db, 'listing_snapshots')).toBe(4);
    expect(await count(db, "listing_events", "kind = 'appeared'")).toBe(4);
    const t4 = await listing('import-agence', 'AG-0002');
    expect(t4).toMatchObject({ price: 262000, postal_code: '56000', presence_status: 'seen' });
    expect(t4.first_seen_at.toISOString()).toBe('2026-10-13T05:00:00.000Z');
  });

  it('rejouer le même fichier ne crée aucun doublon', async () => {
    const { connector, scope } = csv('annonces-pilote-2026-10-13.csv', '2026-10-13T07:00:00+02:00');
    const first = await runCollection(db, connector, scope);
    const replay = await runCollection(db, connector, scope);
    expect(replay).toMatchObject({ runId: first.runId, alreadyDone: true, status: 'complete' });
    expect(await count(db, 'collection_runs')).toBe(1);
    expect(await count(db, 'listings')).toBe(4);
    expect(await count(db, 'listing_observations')).toBe(4);
    expect(await count(db, 'listing_snapshots')).toBe(4);
    expect(await count(db, 'listing_events')).toBe(4);
  });

  it('rejouer une collecte Leboncoin ajoute une observation par annonce, sans nouvelle annonce ni snapshot', async () => {
    const first = await runCollection(db, lbc('vannes-3-pages'), lbcScope);
    expect(first).toMatchObject({ status: 'complete', pagesFetched: 3 });
    // 7 annonces lues (une répétée entre les pages 1 et 2) → 6 annonces distinctes.
    expect(first.counts).toMatchObject({ seen: 6, created: 6 });
    const second = await runCollection(db, lbc('vannes-3-pages'), lbcScope);
    expect(second.counts).toMatchObject({ seen: 6, created: 0, updated: 0, unchanged: 6 });
    expect(await count(db, 'listings')).toBe(6);
    expect(await count(db, 'listing_snapshots')).toBe(6);
    expect(await count(db, 'listing_observations')).toBe(12);
    expect(await count(db, 'listing_events')).toBe(6);
  });

  it('un changement de prix crée un snapshot et un seul événement, même rejoué', async () => {
    await runCollection(db, lbc('vannes-3-pages'), lbcScope);
    const changed = await runCollection(db, lbc('vannes-prix-modifie'), lbcScope);
    expect(changed.counts).toMatchObject({ updated: 1, unchanged: 5 });
    await runCollection(db, lbc('vannes-prix-modifie'), lbcScope);

    const l = await listing('leboncoin', '900000002');
    expect(l.price).toBe(215000);
    expect(await count(db, 'listing_snapshots', 'listing_id = $1', [l.id])).toBe(2);
    const events = (await db.query("SELECT kind, payload FROM listing_events WHERE listing_id = $1 AND kind <> 'appeared' ORDER BY kind", [l.id])).rows;
    // Le prix et la date de mise à jour source ont changé : un événement de prix, un de modification.
    expect(events).toEqual([
      { kind: 'modified', payload: { fields: ['sourceUpdatedAt'] } },
      { kind: 'price_changed', payload: { from: 229000, to: 215000 } },
    ]);
  });

  it('un nouvel export avec un prix modifié met à jour la même annonce', async () => {
    const a = csv('annonces-pilote-2026-10-13.csv', '2026-10-13T07:00:00+02:00');
    const b = csv('annonces-pilote-2026-10-14.csv', '2026-10-14T07:00:00+02:00');
    await runCollection(db, a.connector, a.scope);
    const run = await runCollection(db, b.connector, b.scope);
    expect(run.counts).toMatchObject({ created: 0, updated: 1, unchanged: 3 });
    expect((await listing('import-agence', 'AG-0002')).price).toBe(249000);
    expect(await count(db, 'listings')).toBe(4);
  });

  it('un export plus ancien importé après coup enrichit l’historique sans écraser l’état courant', async () => {
    const recent = csv('annonces-pilote-2026-10-14.csv', '2026-10-14T07:00:00+02:00');
    const old = csv('annonces-pilote-2026-10-13.csv', '2026-10-13T07:00:00+02:00');
    await runCollection(db, recent.connector, recent.scope);
    await runCollection(db, old.connector, old.scope);
    const l = await listing('import-agence', 'AG-0002');
    expect(l.price).toBe(249000);
    expect(l.last_seen_at.toISOString()).toBe('2026-10-14T05:00:00.000Z');
    expect(await count(db, 'listing_snapshots', 'listing_id = $1', [l.id])).toBe(2);
    expect(await count(db, "listing_events", "kind = 'price_changed'")).toBe(0);
  });

  it('une panne n’entraîne aucun faux retrait', async () => {
    await runCollection(db, lbc('vannes-3-pages'), lbcScope);
    const failed = await runCollection(db, flaky(lbc('vannes-3-pages'), new Set([0])), lbcScope, noWait);
    expect(failed.status).toBe('failed');
    const blocked = await runCollection(db, flaky(lbc('vannes-3-pages'), new Set([0]), 'challenge'), lbcScope, noWait);
    expect(blocked.status).toBe('blocked');
    expect(await count(db, 'listings', "presence_status = 'seen' AND missed_complete_runs = 0")).toBe(6);
    expect(await count(db, 'listing_events', "kind = 'not_seen'")).toBe(0);
  });

  it('une panne en cours de collecte donne une collecte partielle, reprenable sans doublon', async () => {
    const partial = await runCollection(db, flaky(lbc('vannes-3-pages'), new Set([1])), lbcScope, noWait);
    expect(partial).toMatchObject({ status: 'partial', pagesFetched: 1 });
    expect(partial.counts.created).toBe(2);
    // Erreur temporaire retentée deux fois, puis abandon : la dernière erreur est conservée.
    expect(partial.errors).toHaveLength(1);

    const resumed = await runCollection(db, lbc('vannes-3-pages'), lbcScope, { resumeRunId: partial.runId });
    expect(resumed).toMatchObject({ runId: partial.runId, status: 'complete', pagesFetched: 3 });
    expect(resumed.counts).toMatchObject({ seen: 6, created: 6 });
    expect(await count(db, 'listings')).toBe(6);
    expect(await count(db, 'listing_observations')).toBe(6);
    expect(await count(db, 'collection_runs')).toBe(1);
  });

  it('un plafond de pages rend la collecte partielle, jamais complète', async () => {
    const run = await runCollection(db, lbc('vannes-3-pages'), lbcScope, { maxPages: 2 });
    expect(run).toMatchObject({ status: 'partial', pagesFetched: 2 });
  });

  it('des lignes rejetées rendent la collecte partielle et identifiable', async () => {
    const scope = { filePath: path.join(FIXTURES, 'import', 'annonces-invalides.json'), sourceId: 'import-agence' };
    const run = await runCollection(db, new FileImportConnector(scope), scope);
    expect(run).toMatchObject({ status: 'partial', counts: { created: 1, rejected: 4 } });
    const { rows } = await db.query('SELECT rejected FROM collection_runs WHERE id = $1', [run.runId]);
    expect(rows[0].rejected).toHaveLength(4);
  });

  it('une source bloquée ne bloque pas les autres', async () => {
    const file = csv('annonces-pilote-2026-10-13.csv', '2026-10-13T07:00:00+02:00');
    const results = await runSources(db, [
      { connector: lbc('captcha'), scope: lbcScope },
      { connector: file.connector, scope: file.scope },
    ]);
    expect(results.map((r) => [r.sourceId, r.status])).toEqual([['leboncoin', 'blocked'], ['import-agence', 'complete']]);
    expect(await count(db, 'listings', "source_id = 'import-agence'")).toBe(4);
  });

  it('une source désactivée ou non autorisée n’est pas interrogée', async () => {
    const transport = new FixtureTransport(path.join(FIXTURES, 'leboncoin', 'vannes-3-pages'));
    Object.defineProperty(transport, 'live', { value: true }); // simule un transport réel
    const run = await runCollection(db, new LeboncoinConnector(transport), lbcScope);
    expect(run.status).toBe('blocked');
    expect(run.blockReason).toMatch(/non autorisé/);
    expect(transport.requests).toHaveLength(0);

    await db.query("UPDATE sources SET enabled = false WHERE id = 'leboncoin'");
    const disabled = await runCollection(db, lbc('vannes-3-pages'), lbcScope);
    expect([disabled.status, disabled.blockReason]).toEqual(['blocked', 'source désactivée']);
  });

  it('seules des collectes complètes ET exhaustives font passer une annonce en « non revue », jamais en « retirée »', async () => {
    const full = csv('annonces-pilote-2026-10-13.csv', '2026-10-13T07:00:00+02:00', { exhaustive: true });
    await runCollection(db, full.connector, full.scope);
    // Deux exports exhaustifs ultérieurs sans AG-0004.
    const without = (day: string) => {
      const scope = { filePath: path.join(FIXTURES, 'import', `sans-ag-0004-${day}.json`), sourceId: 'import-agence', exhaustive: true };
      return { connector: new FileImportConnector(scope), scope };
    };
    const d1 = without('2026-10-14');
    await runCollection(db, d1.connector, d1.scope);
    expect(await listing('import-agence', 'AG-0004')).toMatchObject({ presence_status: 'seen', missed_complete_runs: 1 });
    const d2 = without('2026-10-15');
    await runCollection(db, d2.connector, d2.scope);
    expect(await listing('import-agence', 'AG-0004')).toMatchObject({ presence_status: 'not_seen', missed_complete_runs: 2 });
    expect(await count(db, 'listing_events', "kind = 'not_seen'")).toBe(1);

    // Réapparition.
    const back = csv('annonces-pilote-2026-10-14.csv', '2026-10-16T07:00:00+02:00', { exhaustive: true });
    await runCollection(db, back.connector, back.scope);
    expect(await listing('import-agence', 'AG-0004')).toMatchObject({ presence_status: 'seen', missed_complete_runs: 0 });
    expect(await count(db, 'listing_events', "kind = 'reappeared'")).toBe(1);
  });
});

describe('sources réelles', () => {
  it('un refus sur une source réelle autorisée la repasse en « blocked »', async () => {
    const transport = new FixtureTransport(path.join(FIXTURES, 'leboncoin', 'captcha'));
    Object.defineProperty(transport, 'live', { value: true });
    await db.query(`INSERT INTO sources (id, name, kind, connector_version, access_status) VALUES ('leboncoin', 'Leboncoin', 'portal', 'x', 'authorized')`);
    const run = await runCollection(db, new LeboncoinConnector(transport), lbcScope, noWait);
    expect(run.status).toBe('blocked');
    const { rows } = await db.query("SELECT access_status FROM sources WHERE id = 'leboncoin'");
    expect(rows[0].access_status).toBe('blocked');
    // Relancer ne contacte plus la source tant qu'elle n'est pas réautorisée.
    const again = await runCollection(db, new LeboncoinConnector(transport), lbcScope, noWait);
    expect(again.blockReason).toMatch(/access_status=blocked/);
    expect(transport.requests).toHaveLength(1);
  });
});
