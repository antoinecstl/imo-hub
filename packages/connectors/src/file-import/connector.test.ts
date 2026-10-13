import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../../../../tests/helpers/fixtures.ts';
import { FileImportConnector } from './connector.ts';

const file = (name: string) => path.join(FIXTURES, 'import', name);

describe('import CSV/JSON', () => {
  it('lit un CSV : cellules vides = inconnu, nombres décimaux, classes en majuscules', async () => {
    const scope = { filePath: file('annonces-pilote-2026-10-13.csv'), sourceId: 'import-agence' };
    const res = await new FileImportConnector(scope).discover(scope, null, 0);
    expect(res.status).toBe('ok');
    expect(res.rejected).toEqual([]);
    expect(res.listings).toHaveLength(4);
    const t4 = res.listings.find((l) => l.externalId === 'AG-0002')!;
    expect(t4).toMatchObject({ price: 262000, surfaceValue: 81.5, surfaceKind: 'carrez', dpeNumber: '2356E1234567X', energyClass: 'D' });
    const studio = res.listings.find((l) => l.externalId === 'AG-0004')!;
    expect(studio).toMatchObject({ energyClass: null, energyValue: null, latitude: null, sourcePublishedAt: null, sourceUrl: null, bedrooms: 0 });
  });

  it('rejette les lignes invalides avec leur numéro et garde les autres', async () => {
    const scope = { filePath: file('annonces-invalides.json'), sourceId: 'import-agence' };
    const connector = new FileImportConnector(scope);
    const res = await connector.discover(scope, null, 0);
    expect(res.listings.map((l) => l.externalId)).toEqual(['AG-0101']);
    expect(res.rejected.map((r) => r.itemRef)).toEqual(['ligne 2', 'ligne 3', 'ligne 4', 'ligne 5']);
    // Un prix sans devise est refusé : on ne suppose pas l'euro.
    expect(res.rejected[2]!.errors.join()).toMatch(/currency/);
    expect(await connector.observedAt(scope)).toEqual(new Date('2026-10-13T05:00:00Z'));
  });

  it('donne la même clé d’idempotence pour le même fichier', async () => {
    const scope = { filePath: file('annonces-pilote-2026-10-13.csv'), sourceId: 'import-agence' };
    const c = new FileImportConnector(scope);
    expect(await c.runKey(scope)).toBe(await c.runKey(scope));
    expect(await c.runKey({ ...scope, filePath: file('annonces-pilote-2026-10-14.csv') })).not.toBe(await c.runKey(scope));
  });
});
