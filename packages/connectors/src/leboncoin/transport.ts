import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GuardedHttpClient, ResponseRecorder } from '../http/guarded.ts';

export interface LbcSearchRequest {
  locations: string[];
  category: string;
  ownerType: 'all' | 'private' | 'pro';
  priceMin: number | null;
  priceMax: number | null;
  limit: number;
  pivot: string | null;
}

export interface LbcHttpResponse {
  status: number;
  contentType: string;
  body: unknown;
}

export interface LbcTransport {
  /** true si le transport contacte réellement Leboncoin (soumis à validation d'accès). */
  readonly live: boolean;
  search(request: LbcSearchRequest): Promise<LbcHttpResponse>;
}

/**
 * Transport hors ligne : sert des réponses enregistrées dans un dossier.
 * `index.json` associe un pivot (ou "__first__") à un fichier de réponse et un statut HTTP.
 */
export class FixtureTransport implements LbcTransport {
  readonly live = false;
  readonly requests: LbcSearchRequest[] = [];

  constructor(private readonly dir: string) {}

  async search(request: LbcSearchRequest): Promise<LbcHttpResponse> {
    this.requests.push(request);
    const index = JSON.parse(await readFile(path.join(this.dir, 'index.json'), 'utf8')) as Record<
      string,
      { file: string; status?: number; contentType?: string }
    >;
    const entry = index[request.pivot ?? '__first__'];
    if (!entry) throw new Error(`fixture absente pour le pivot ${request.pivot ?? '__first__'}`);
    const raw = await readFile(path.join(this.dir, entry.file), 'utf8');
    const contentType = entry.contentType ?? (entry.file.endsWith('.json') ? 'application/json' : 'text/html');
    return { status: entry.status ?? 200, contentType, body: contentType.includes('json') ? JSON.parse(raw) : raw };
  }
}

/**
 * Transport réel vers l'API de recherche Leboncoin (endpoint utilisé par le dépôt tiers).
 * Pas de clé d'application, de cookie anti-robot ni de User-Agent d'application emprunté :
 * un refus ou un CAPTCHA est remonté tel quel et arrête la source (voir docs/decisions/0006-tests-reels.md).
 */
export class LiveLbcTransport implements LbcTransport {
  readonly live = true;

  constructor(
    private readonly http: GuardedHttpClient,
    private readonly recorder?: ResponseRecorder,
  ) {}

  async search(request: LbcSearchRequest): Promise<LbcHttpResponse> {
    const ranges: Record<string, unknown> = {};
    if (request.priceMin !== null || request.priceMax !== null) {
      ranges.price = { ...(request.priceMin !== null ? { min: request.priceMin } : {}), ...(request.priceMax !== null ? { max: request.priceMax } : {}) };
    }
    const body = {
      filters: {
        category: { id: request.category },
        enums: { ad_type: ['offer'] },
        ranges,
        location: { locations: request.locations.map((zipcode) => ({ locationType: 'city', zipcode })) },
      },
      limit: request.limit,
      ...(request.pivot ? { pivot: request.pivot } : {}),
      owner_type: request.ownerType,
      sort_by: 'time',
      sort_order: 'desc',
    };
    const res = await this.http.request('https://api.leboncoin.fr/finder/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    await this.recorder?.save(request.pivot ?? '__first__', res);
    let parsed: unknown = res.text;
    if (res.contentType.includes('json')) {
      try {
        parsed = JSON.parse(res.text);
      } catch {
        parsed = res.text;
      }
    }
    return { status: res.status, contentType: res.contentType, body: parsed };
  }
}
