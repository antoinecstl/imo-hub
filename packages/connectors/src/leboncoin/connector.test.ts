import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../../../../tests/helpers/fixtures.ts';
import { LeboncoinConnector } from './connector.ts';
import { FixtureTransport, type LbcHttpResponse, type LbcTransport } from './transport.ts';

const scope = { locations: ['56000', '56860'] };
const fixtures = (name: string) => new FixtureTransport(path.join(FIXTURES, 'leboncoin', name));

class StubTransport implements LbcTransport {
  readonly live = false;
  constructor(private readonly respond: (pivot: string | null) => LbcHttpResponse | Promise<LbcHttpResponse>) {}
  async search(req: { pivot: string | null }) {
    return this.respond(req.pivot);
  }
}

describe('adaptateur Leboncoin (hors ligne)', () => {
  it('normalise une annonce sans inventer de valeur', async () => {
    const res = await new LeboncoinConnector(fixtures('vannes-3-pages')).discover(scope, null, 0);
    expect(res.status).toBe('ok');
    const maison = res.listings.find((l) => l.externalId === '900000001')!;
    expect(maison).toMatchObject({
      sourceId: 'leboncoin', transactionType: 'sale', propertyType: 'house', sellerType: 'private',
      price: 385000, currency: 'EUR', surfaceValue: 112, surfaceKind: 'living', landSurface: 540, rooms: 5,
      city: 'Vannes', postalCode: '56000', locationPrecision: 'city', energyClass: 'D', gesClass: 'B',
      sourceHasPhone: true, sourcePublishedAt: '2026-10-01T07:12:44.000Z',
      // Absent de la source : reste absent.
      addressText: null, dpeNumber: null, energyValue: null, bedrooms: null,
    });
    // has_phone ne devient jamais un numéro : aucun champ de téléphone dans le contrat.
    expect(Object.keys(maison).filter((k) => /phone/i.test(k))).toEqual(['sourceHasPhone']);
  });

  it('suit la pagination par pivot et conserve la dernière page', async () => {
    const connector = new LeboncoinConnector(fixtures('vannes-3-pages'));
    const ids: string[] = [];
    let cursor: string | null = null;
    let page = 0;
    do {
      const res = await connector.discover(scope, cursor, page++);
      ids.push(...res.listings.map((l) => l.externalId));
      cursor = res.nextCursor;
    } while (cursor);
    expect(page).toBe(3);
    // 900000005 et 900000006 sont sur la dernière page, sans pivot.
    expect(new Set(ids)).toEqual(new Set(['900000001', '900000002', '900000003', '900000004', '900000005', '900000006']));
  });

  it('garde null pour un prix à 0, une surface absente et une classe DPE « v »', async () => {
    const connector = new LeboncoinConnector(fixtures('vannes-3-pages'));
    const p2 = await connector.discover(scope, 'pivot-page-2', 1);
    const p3 = await connector.discover(scope, 'pivot-page-3', 2);
    const aRenover = p2.listings.find((l) => l.externalId === '900000004')!;
    expect(aRenover).toMatchObject({ surfaceValue: null, surfaceKind: null, energyClass: null, gesClass: null });
    const bourg = p3.listings.find((l) => l.externalId === '900000006')!;
    expect(bourg).toMatchObject({ price: null, currency: null });
    expect(p3.nextCursor).toBeNull();
  });

  it('arrête la source sur un CAPTCHA sans réessayer ni contourner', async () => {
    const transport = fixtures('captcha');
    const res = await new LeboncoinConnector(transport).discover(scope, null, 0);
    expect(res.status).toBe('blocked');
    expect(res.errors[0]?.kind).toBe('challenge');
    expect(transport.requests).toHaveLength(1);
  });

  it('distingue refus, limitation, erreur serveur, panne réseau et schéma inattendu', async () => {
    const forbidden = await new LeboncoinConnector(fixtures('forbidden')).discover(scope, null, 0);
    expect([forbidden.status, forbidden.errors[0]?.kind]).toEqual(['blocked', 'forbidden']);

    const limited = await new LeboncoinConnector(new StubTransport(() => ({ status: 429, contentType: 'application/json', body: {} }))).discover(scope, null, 0);
    expect([limited.status, limited.errors[0]?.kind]).toEqual(['blocked', 'rate_limited']);

    const server = await new LeboncoinConnector(new StubTransport(() => ({ status: 502, contentType: 'text/html', body: 'Bad gateway' }))).discover(scope, null, 0);
    expect([server.status, server.errors[0]?.kind]).toEqual(['failed', 'http']);

    const network = await new LeboncoinConnector(new StubTransport(() => Promise.reject(new Error('ECONNRESET')))).discover(scope, 'p', 4);
    expect([network.status, network.errors[0]?.kind, network.nextCursor]).toEqual(['failed', 'network', 'p']);

    const schema = await new LeboncoinConnector(fixtures('schema-inattendu')).discover(scope, null, 0);
    expect([schema.status, schema.errors[0]?.kind]).toEqual(['failed', 'unexpected_schema']);
  });

  it('distingue une page vide d’une erreur', async () => {
    const res = await new LeboncoinConnector(new StubTransport(() => ({ status: 200, contentType: 'application/json', body: { total: 0, max_pages: 0, ads: [] } }))).discover(scope, null, 0);
    expect(res).toMatchObject({ status: 'ok', listings: [], rejected: [], errors: [], nextCursor: null });
  });

  it('rejette une annonce mal formée sans perdre le reste de la page', async () => {
    const body = { total: 2, max_pages: 1, ads: [{ subject: 'sans identifiant' }, { list_id: 42, category_id: '9', price: [100000] }] };
    const res = await new LeboncoinConnector(new StubTransport(() => ({ status: 200, contentType: 'application/json', body }))).discover(scope, null, 0);
    expect(res.listings.map((l) => l.externalId)).toEqual(['42']);
    expect(res.rejected).toHaveLength(1);
  });

  it('signale une recherche tronquée par la source', async () => {
    const body = { total: 5000, max_pages: 100, pivot: 'x', ads: [{ list_id: 1 }] };
    const res = await new LeboncoinConnector(new StubTransport(() => ({ status: 200, contentType: 'application/json', body }))).discover(scope, null, 0);
    expect(res.truncated).toBe(true);
  });
});
