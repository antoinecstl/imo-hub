import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface AdemeHttpResponse {
  status: number;
  contentType: string;
  body: unknown;
}

export interface AdemeTransport {
  get(url: string): Promise<AdemeHttpResponse>;
}

/** Accès HTTP réel à l'API data-fair de l'ADEME (données publiques sous Licence Ouverte 2.0). */
export class HttpAdemeTransport implements AdemeTransport {
  private last = 0;

  constructor(
    private readonly opts: { timeoutMs?: number; minIntervalMs?: number; userAgent?: string } = {},
  ) {}

  async get(url: string): Promise<AdemeHttpResponse> {
    // Politesse : un appel à la fois, espacés d'au moins minIntervalMs.
    const wait = this.last + (this.opts.minIntervalMs ?? 500) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': this.opts.userAgent ?? 'imo-hub/0.1 (collecte DPE secteur pilote)' },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    const contentType = res.headers.get('content-type') ?? '';
    const body = contentType.includes('json') ? await res.json().catch(() => null) : await res.text();
    return { status: res.status, contentType, body };
  }
}

/**
 * Transport hors ligne : `index.json` associe une URL (ou "__first__" pour la première requête)
 * à un fichier de réponse. Les URL de pagination `next` des fixtures pointent vers d'autres entrées.
 */
export class AdemeFixtureTransport implements AdemeTransport {
  readonly urls: string[] = [];

  constructor(private readonly dir: string) {}

  async get(url: string): Promise<AdemeHttpResponse> {
    this.urls.push(url);
    const index = JSON.parse(await readFile(path.join(this.dir, 'index.json'), 'utf8')) as Record<string, { file: string; status?: number }>;
    const entry = index[url] ?? (this.urls.length === 1 ? index.__first__ : undefined);
    if (!entry) throw new Error(`fixture absente pour ${url}`);
    return { status: entry.status ?? 200, contentType: 'application/json', body: JSON.parse(await readFile(path.join(this.dir, entry.file), 'utf8')) };
  }
}
