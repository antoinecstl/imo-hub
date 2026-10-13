import { NormalizedListing, type Connector, type ConnectorResult } from '@imo/contracts';
import { accessFailure, connectorError, sha256, stableStringify } from '../util.ts';
import { normalizePapItem, PAP_PARSER_VERSION, PAP_SOURCE_ID, parsePapPage } from './parse.ts';
import type { PapTransport } from './transport.ts';

export interface PapScope {
  /** URL de recherche PAP par commune du secteur (vente, tous biens), première page. */
  searchUrls: string[];
}

/** Curseur : index de la recherche en cours et URL de la page à lire. */
interface PapCursor {
  search: number;
  url: string;
}

const CHALLENGE = [/captcha/i, /datadome/i, /cf-chl/i, /challenge-platform/i, /access denied/i, /are you a robot/i];

export class PapConnector implements Connector<PapScope> {
  readonly source = { id: PAP_SOURCE_ID, name: 'PAP', kind: 'portal' as const };
  readonly version = PAP_PARSER_VERSION;
  readonly capabilities;

  constructor(private readonly transport: PapTransport) {
    this.capabilities = { detail: false, requiresAuthorizedAccess: transport.live };
  }

  scopeKey(scope: PapScope): string {
    return `pap:${[...scope.searchUrls].sort().join('|')}`;
  }

  async exhaustive(): Promise<boolean> {
    return false; // couverture non mesurée
  }

  async runKey(): Promise<null> {
    return null;
  }

  async observedAt(): Promise<null> {
    return null;
  }

  async health() {
    return this.transport.live ? { ok: false, detail: 'transport réel : soumis à access_status = authorized' } : { ok: true, detail: 'transport de fixtures (hors ligne)' };
  }

  async discover(scope: PapScope, cursor: string | null, page: number): Promise<ConnectorResult> {
    const result: ConnectorResult = { status: 'ok', listings: [], raw: {}, rejected: [], errors: [], page, pagesExpected: null, nextCursor: null, truncated: false };
    if (!scope.searchUrls.length) return { ...result, status: 'failed', errors: [connectorError('unexpected_schema', 'aucune URL de recherche', page)] };
    const at: PapCursor = cursor ? (JSON.parse(cursor) as PapCursor) : { search: 0, url: scope.searchUrls[0]! };

    let res;
    try {
      res = await this.transport.get(at.url);
    } catch (err) {
      return accessFailure(result, err, cursor, page);
    }
    if (res.status === 401 || res.status === 403) return { ...result, status: 'blocked', nextCursor: cursor, errors: [connectorError('forbidden', `HTTP ${res.status}`, page)] };
    if (res.status === 429) return { ...result, status: 'blocked', nextCursor: cursor, errors: [connectorError('rate_limited', 'HTTP 429 : pause de la source', page)] };
    const parsed = parsePapPage(res.body, at.url);
    if (!parsed.items.length && CHALLENGE.some((re) => re.test(res.body))) {
      return { ...result, status: 'blocked', nextCursor: cursor, errors: [connectorError('challenge', 'challenge/CAPTCHA détecté : arrêt sans contournement', page)] };
    }
    if (res.status >= 400) return { ...result, status: 'failed', nextCursor: cursor, errors: [connectorError('http', `HTTP ${res.status}`, page)] };
    if (!parsed.hasStructuredData) {
      // Sans données structurées, impossible de distinguer « aucune annonce » d'un changement de format.
      return { ...result, status: 'failed', nextCursor: cursor, errors: [connectorError('unexpected_schema', 'aucune donnée structurée JSON-LD dans la page', page)] };
    }

    for (const [i, item] of parsed.items.entries()) {
      const candidate = normalizePapItem(item, at.url);
      const ref = candidate?.externalId ?? `page${page}#${i}`;
      const valid = candidate ? NormalizedListing.safeParse(candidate) : null;
      if (!valid?.success) {
        result.rejected.push({ itemRef: ref, errors: valid ? valid.error!.issues.map((x) => `${x.path.join('.')}: ${x.message}`) : ['identifiant introuvable'] });
        continue;
      }
      result.listings.push(valid.data);
      result.raw[ref] = { hash: sha256(stableStringify(item)), excerpt: null };
    }

    // Page suivante de la même recherche, sinon première page de la recherche suivante.
    const next: PapCursor | null = parsed.nextUrl && parsed.nextUrl !== at.url && parsed.items.length
      ? { search: at.search, url: parsed.nextUrl }
      : at.search + 1 < scope.searchUrls.length ? { search: at.search + 1, url: scope.searchUrls[at.search + 1]! } : null;
    result.nextCursor = next ? JSON.stringify(next) : null;
    return result;
  }
}
