import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileImportConnector, FixtureTransport, LeboncoinConnector } from '@imo/connectors';
import type { Db } from '@imo/db';
import { runCollection } from '@imo/domain';
import { buildApp } from '@imo/web';
import { FIXTURES, resetDb, setupDb } from '../helpers/db.ts';

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await setupDb();
  await resetDb(db);
  const scope = { filePath: path.join(FIXTURES, 'import', 'annonces-pilote-2026-10-13.csv'), sourceId: 'import-agence', observedAt: '2026-10-13T07:00:00+02:00' };
  await runCollection(db, new FileImportConnector(scope), scope);
  const lbc = (dir: string) => new LeboncoinConnector(new FixtureTransport(path.join(FIXTURES, 'leboncoin', dir)));
  await runCollection(db, lbc('vannes-3-pages'), { locations: ['56000', '56860'] });
  await runCollection(db, lbc('vannes-prix-modifie'), { locations: ['56000', '56860'] });
  app = buildApp(db);
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe('API de lecture', () => {
  it('pagine les annonces de façon stable', async () => {
    const p1 = (await app.inject('/api/listings?pageSize=4&page=1')).json();
    const p3 = (await app.inject('/api/listings?pageSize=4&page=3')).json();
    expect(p1).toMatchObject({ total: 10, totalPages: 3, page: 1, pageSize: 4 });
    expect(p1.items).toHaveLength(4);
    expect(p3.items).toHaveLength(2);
    const all = [];
    for (let page = 1; page <= 3; page++) all.push(...(await app.inject(`/api/listings?pageSize=4&page=${page}`)).json().items);
    expect(new Set(all.map((x: { id: string }) => x.id)).size).toBe(10);
  });

  it('filtre par source, code postal, type d’annonceur, prix et rayon', async () => {
    const q = async (s: string) => (await app.inject(`/api/listings?${s}`)).json();
    expect((await q('source=leboncoin')).total).toBe(6);
    expect((await q('postalCode=56860&source=leboncoin')).total).toBe(3);
    expect((await q('sellerType=professional')).total).toBe(2);
    expect((await q('maxPrice=200000')).items.every((x: { price: number }) => x.price <= 200000)).toBe(true);
    // Autour du centre de Vannes, 1,5 km : exclut Séné et Theix-Noyalo.
    const near = await q('lat=47.6586&lng=-2.7599&radiusM=1500');
    expect(near.items.map((x: { city: string }) => x.city).every((c: string) => c === 'Vannes')).toBe(true);
  });

  it('expose source, lien, caractéristiques et date d’observation ; absent = null', async () => {
    const { items } = (await app.inject('/api/listings?source=leboncoin&postalCode=56860')).json();
    const terrain = items.find((x: { externalId: string }) => x.externalId === '900000005');
    expect(terrain).toMatchObject({
      sourceId: 'leboncoin', sourceUrl: 'https://www.leboncoin.fr/ad/ventes_immobilieres/900000005',
      propertyType: 'land', surfaceValue: null, rooms: null, energyClass: null,
    });
    expect(terrain.lastSeenAt).toBeTruthy();
  });

  it('donne le détail avec historique de prix', async () => {
    const { items } = (await app.inject('/api/listings?source=leboncoin&maxPrice=220000&propertyType=apartment&sellerType=private')).json();
    const detail = (await app.inject(`/api/listings/${items[0].id}`)).json();
    expect(detail.externalId).toBe('900000002');
    expect(detail.snapshots).toHaveLength(2);
    expect(detail.observations).toHaveLength(2);
    expect(detail.events.map((e: { kind: string }) => e.kind)).toContain('price_changed');
    expect(detail.current.sourceHasPhone).toBe(false);
  });

  it('refuse les paramètres invalides et les identifiants inconnus', async () => {
    expect((await app.inject('/api/listings?pageSize=1000')).statusCode).toBe(400);
    expect((await app.inject('/api/listings?postalCode=abc')).statusCode).toBe(400);
    expect((await app.inject('/api/listings/pas-un-uuid')).statusCode).toBe(404);
  });

  it('expose l’état des sources, des collectes et la complétude', async () => {
    const sources = (await app.inject('/api/sources')).json().items;
    expect(sources.map((s: { id: string }) => s.id)).toEqual(['import-agence', 'leboncoin']);
    expect(sources[1]).toMatchObject({ accessStatus: 'unverified', listingCount: 6, lastRun: { status: 'complete' } });
    const runs = (await app.inject('/api/runs?source=leboncoin')).json().items;
    expect(runs).toHaveLength(2);
    const completeness = (await app.inject('/api/quality/completeness')).json().items;
    expect(completeness.find((c: { source_id: string; field: string }) => c.source_id === 'leboncoin' && c.field === 'dpeNumber')).toMatchObject({ filled: 0, total: 6 });
  });

  it('sert la page technique et la fiche HTML en échappant le contenu', async () => {
    const page = await app.inject('/?source=leboncoin');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('Dernières collectes');
    expect(page.body).toContain('900000002');
    const { items } = (await app.inject('/api/listings?pageSize=1')).json();
    expect((await app.inject(`/listings/${items[0].id}`)).statusCode).toBe(200);
  });
});
