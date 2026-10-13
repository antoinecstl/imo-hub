import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../../../../tests/helpers/fixtures.ts';
import { PapConnector } from './connector.ts';
import { normalizePapItem, papIdFromUrl, parsePapPage } from './parse.ts';
import { PapFixtureTransport } from './transport.ts';

const NICE = 'https://www.pap.fr/annonce/vente-immobiliere-nice-06-fixture';
const SGL = 'https://www.pap.fr/annonce/vente-immobiliere-saint-germain-en-laye-78-fixture';
const scope = { searchUrls: [NICE, SGL] };
const fixtures = (name: string) => new PapFixtureTransport(path.join(FIXTURES, 'pap', name));

async function collectAll(connector: PapConnector, s = scope) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    const res = await connector.discover(s, cursor, page++);
    expect(res.status).toBe('ok');
    ids.push(...res.listings.map((l) => l.externalId));
    cursor = res.nextCursor;
  } while (cursor);
  return { ids, pages: page };
}

describe('adaptateur PAP (hors ligne)', () => {
  it('extrait l’identifiant PAP de l’URL', () => {
    expect(papIdFromUrl('https://www.pap.fr/annonces/appartement-nice-06000-r900000101')).toBe('r900000101');
    expect(papIdFromUrl('https://www.pap.fr/annonces/x?y=1')).toBeNull();
  });

  it('normalise une annonce JSON-LD sans inventer de valeur', async () => {
    const res = await new PapConnector(fixtures('pilote')).discover(scope, null, 0);
    const t3 = res.listings.find((l) => l.externalId === 'r900000101')!;
    expect(t3).toMatchObject({
      sourceId: 'pap', sourceUrl: 'https://www.pap.fr/annonces/appartement-nice-06000-r900000101',
      propertyType: 'apartment', transactionType: 'sale', sellerType: 'private', price: 489000, currency: 'EUR',
      surfaceValue: 68, surfaceKind: 'living', rooms: 3, bedrooms: 2, city: 'Nice', postalCode: '06000',
      latitude: 43.6961, locationPrecision: 'city', sourcePublishedAt: '2026-10-08T07:30:00.000Z',
      energyClass: null, dpeNumber: null, sourceHasPhone: null,
    });
    const maison = res.listings.find((l) => l.externalId === 'r900000103')!;
    expect(maison).toMatchObject({ propertyType: 'house', price: null, currency: null });
  });

  it('parcourt chaque commune et la dernière page de chacune', async () => {
    const { ids, pages } = await collectAll(new PapConnector(fixtures('pilote')));
    expect(pages).toBe(3);
    expect(new Set(ids)).toEqual(new Set(['r900000101', 'r900000102', 'r900000103', 'r900000104', 'r900000201', 'r900000202']));
  });

  it('distingue CAPTCHA, refus, format changé et page vide', async () => {
    const one = (url: string) => new PapConnector(fixtures('anomalies')).discover({ searchUrls: [url] }, null, 0);
    const challenge = await one('https://www.pap.fr/challenge');
    expect([challenge.status, challenge.errors[0]?.kind]).toEqual(['blocked', 'challenge']);
    const forbidden = await one('https://www.pap.fr/interdit');
    expect([forbidden.status, forbidden.errors[0]?.kind]).toEqual(['blocked', 'forbidden']);
    const changed = await one('https://www.pap.fr/sans-json-ld');
    expect([changed.status, changed.errors[0]?.kind]).toEqual(['failed', 'unexpected_schema']);
    const empty = await one('https://www.pap.fr/vide');
    expect(empty).toMatchObject({ status: 'ok', listings: [], rejected: [], nextCursor: null });
  });

  it('rejette une annonce sans identifiant et lit les variantes @graph', () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"Offer","name":"Sans URL","price":100000,"priceCurrency":"EUR"},
      {"@type":"RealEstateListing","url":"https://www.pap.fr/annonces/maison-x-r900000999","name":"Maison 4 pièces","offers":{"price":"250 000","priceCurrency":"EUR"}}]}</script>`;
    const page = parsePapPage(html, 'https://www.pap.fr/');
    expect(page.items).toHaveLength(2);
    expect(normalizePapItem(page.items[0]!, 'https://www.pap.fr/')).toBeNull();
    expect(normalizePapItem(page.items[1]!, 'https://www.pap.fr/')).toMatchObject({ externalId: 'r900000999', price: 250000, propertyType: 'house' });
  });
});
