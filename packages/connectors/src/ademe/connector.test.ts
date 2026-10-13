import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../../../../tests/helpers/fixtures.ts';
import { AdemeDpeConnector, buildAdemeQuery, firstPageUrl } from './connector.ts';
import { AdemeFixtureTransport } from './transport.ts';

const scope = { inseeCodes: ['06088', '78551'] };
const fixtures = (name: string) => new AdemeFixtureTransport(path.join(FIXTURES, 'ademe', name));

describe('connecteur ADEME (hors ligne)', () => {
  it('construit la requête du périmètre, y compris le rattrapage par code postal brut', () => {
    expect(buildAdemeQuery(scope)).toBe('code_insee_ban:(06088 OR 78551)');
    expect(buildAdemeQuery({ ...scope, rawPostalCodes: ['06100', '78100'], modifiedSince: '2026-10-01' })).toBe(
      '(code_insee_ban:(06088 OR 78551) OR code_postal_brut:(6100 OR 78100)) AND date_derniere_modification_dpe:>=2026-10-01',
    );
    expect(() => buildAdemeQuery({ inseeCodes: [] })).toThrow();
    const url = new URL(firstPageUrl(scope));
    expect(url.searchParams.get('select')).toContain('numero_dpe_remplace');
  });

  it('normalise un DPE et garde absent ce qui manque', async () => {
    const res = await new AdemeDpeConnector(fixtures('pilote-2-pages')).discover(scope, null, 0);
    expect(res.status).toBe('ok');
    const dpe = res.dpeRecords!.find((d) => d.dpeNumber === '2106E0680409V')!;
    expect(dpe).toMatchObject({
      buildingType: 'apartment', livingArea: 47.2, energyClass: 'E', energyValue: 276.7, gesClass: 'E', gesValue: 58,
      inseeCode: '06088', postalCode: '06100', rawPostalCode: '06100', constructionYear: 1970, floor: 0,
      establishedAt: '2021-11-13', lastModifiedAt: '2026-01-06', locationPrecision: 'exact', latitude: 43.72253903116737,
      rnbId: '8P5P3MFASVFE', replacesDpeNumber: null,
    });
    const nonGeocode = res.dpeRecords!.find((d) => d.dpeNumber === '2606E2539846V')!;
    expect(nonGeocode).toMatchObject({ addressBan: null, postalCode: null, rawPostalCode: '06000', latitude: null, locationPrecision: null, inseeCode: '06088' });
    expect(res.nextCursor).toMatch(/after=fixture-page-2/);
    expect(res.pagesExpected).toBe(1); // 7 résultats / pages de 1000
  });

  it('suit la pagination `next`, conserve la dernière page et rejette une ligne sans numéro', async () => {
    const connector = new AdemeDpeConnector(fixtures('pilote-2-pages'));
    const p1 = await connector.discover(scope, null, 0);
    const p2 = await connector.discover(scope, p1.nextCursor, 1);
    expect(p2.nextCursor).toBeNull();
    expect(p2.dpeRecords!.map((d) => d.dpeNumber)).toEqual(['2678E2536799K', '2678E2536814Z', '2678E2522946P']);
    expect(p2.dpeRecords![1]!.replacesDpeNumber).toBe('2678E2536799K');
    expect(p2.rejected).toHaveLength(1);
  });

  it('met la source en pause sur un quota dépassé', async () => {
    const res = await new AdemeDpeConnector(fixtures('quota')).discover(scope, null, 0);
    expect([res.status, res.errors[0]?.kind]).toEqual(['blocked', 'rate_limited']);
  });
});
