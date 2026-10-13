import type { Connector, ConnectorResult, NormalizedListing } from '@imo/contracts';
import { NormalizedListing as NormalizedListingSchema } from '@imo/contracts';
import { accessFailure, connectorError, sha256, stableStringify } from '../util.ts';
import { LBC_PARSER_VERSION, LBC_SOURCE_ID, normalizeLbcAd } from './normalize.ts';
import { LbcAd, LbcSearchResponse } from './schema.ts';
import type { LbcHttpResponse, LbcTransport } from './transport.ts';

export interface LbcScope {
  /** Codes postaux ou libellés de communes du secteur. */
  locations: string[];
  /** 9 = ventes immobilières, 10 = locations (catégories Leboncoin). */
  category?: '9' | '10';
  ownerType?: 'all' | 'private' | 'pro';
  priceMin?: number | null;
  priceMax?: number | null;
  /** Annonces par page demandées. */
  limit?: number;
}

const CHALLENGE_MARKERS = [/captcha/i, /datadome/i, /geo\.captcha-delivery/i, /access denied/i, /challenge/i];

function looksLikeChallenge(res: LbcHttpResponse): boolean {
  const text = typeof res.body === 'string' ? res.body : stableStringify(res.body);
  return CHALLENGE_MARKERS.some((re) => re.test(text)) && !(typeof res.body === 'object' && res.body !== null && 'ads' in res.body);
}

function emptyResult(page: number): ConnectorResult {
  return { status: 'ok', listings: [], raw: {}, rejected: [], errors: [], page, pagesExpected: null, nextCursor: null, truncated: false };
}

export class LeboncoinConnector implements Connector<LbcScope> {
  readonly source = { id: LBC_SOURCE_ID, name: 'Leboncoin', kind: 'portal' as const };
  readonly version = LBC_PARSER_VERSION;
  readonly capabilities;

  constructor(private readonly transport: LbcTransport) {
    this.capabilities = { detail: false, requiresAuthorizedAccess: transport.live };
  }

  scopeKey(scope: LbcScope): string {
    const locations = [...scope.locations].sort().join(',');
    return `lbc:${scope.category ?? '9'}:${scope.ownerType ?? 'all'}:${locations}:${scope.priceMin ?? ''}-${scope.priceMax ?? ''}`;
  }

  async exhaustive(): Promise<boolean> {
    // Une recherche paginée peut être plafonnée ; on ne la tient pas pour exhaustive tant que
    // la couverture n'a pas été mesurée sur un échantillon de référence.
    return false;
  }

  async runKey(): Promise<string | null> {
    return null;
  }

  async observedAt(): Promise<Date | null> {
    return null;
  }

  async health() {
    return this.transport.live
      ? { ok: false, detail: 'transport réel : soumis à access_status = authorized' }
      : { ok: true, detail: 'transport de fixtures (hors ligne)' };
  }

  async discover(scope: LbcScope, cursor: string | null, page: number): Promise<ConnectorResult> {
    const result = emptyResult(page);
    const limit = scope.limit ?? 35;
    let res: LbcHttpResponse;
    try {
      res = await this.transport.search({
        locations: scope.locations,
        category: scope.category ?? '9',
        ownerType: scope.ownerType ?? 'all',
        priceMin: scope.priceMin ?? null,
        priceMax: scope.priceMax ?? null,
        limit,
        pivot: cursor,
      });
    } catch (err) {
      return accessFailure(result, err, cursor, page);
    }

    if (res.status === 403 || res.status === 401) {
      return { ...result, status: 'blocked', nextCursor: cursor, errors: [connectorError('forbidden', `HTTP ${res.status}`, page)] };
    }
    if (res.status === 429) {
      return { ...result, status: 'blocked', nextCursor: cursor, errors: [connectorError('rate_limited', 'HTTP 429 : pause de la source', page)] };
    }
    if (looksLikeChallenge(res)) {
      return { ...result, status: 'blocked', nextCursor: cursor, errors: [connectorError('challenge', 'challenge/CAPTCHA détecté : arrêt sans contournement', page)] };
    }
    if (res.status >= 400) {
      return { ...result, status: 'failed', nextCursor: cursor, errors: [connectorError('http', `HTTP ${res.status}`, page)] };
    }

    const parsed = LbcSearchResponse.safeParse(res.body);
    if (!parsed.success || !res.contentType.includes('json')) {
      const detail = parsed.success ? `content-type ${res.contentType}` : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { ...result, status: 'failed', nextCursor: cursor, errors: [connectorError('unexpected_schema', `réponse inattendue (${detail})`, page)] };
    }
    const body = parsed.data;
    const ads = body.ads ?? [];
    result.pagesExpected = body.max_pages ?? null;

    for (const [i, rawAd] of ads.entries()) {
      const ad = LbcAd.safeParse(rawAd);
      const ref = ad.success ? String(ad.data.list_id) : `page${page}#${i}`;
      if (!ad.success) {
        result.rejected.push({ itemRef: ref, errors: ad.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`) });
        continue;
      }
      const normalized = NormalizedListingSchema.safeParse(normalizeLbcAd(ad.data));
      if (!normalized.success) {
        result.rejected.push({ itemRef: ref, errors: normalized.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`) });
        continue;
      }
      result.listings.push(normalized.data as NormalizedListing);
      // Seule l'empreinte du brut est conservée : les droits de conservation ne sont pas qualifiés.
      result.raw[ref] = { hash: sha256(stableStringify(rawAd)), excerpt: null };
    }

    // Contrairement à searchMultiples du dépôt tiers, les annonces de la dernière page (sans pivot)
    // sont bien conservées : on n'arrête qu'APRÈS les avoir traitées.
    const hasNext = ads.length > 0 && typeof body.pivot === 'string' && body.pivot !== '' && body.pivot !== cursor;
    result.nextCursor = hasNext ? body.pivot! : null;
    // Si la source annonce plus d'annonces que ce que ses pages permettent d'atteindre, la recherche est tronquée.
    result.truncated = body.max_pages != null && body.total > body.max_pages * limit;
    return result;
  }
}
