import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GuardedHttpClient, ResponseRecorder } from '../http/guarded.ts';

export interface PapHttpResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface PapTransport {
  /** true si le transport contacte réellement pap.fr (soumis à validation d'accès). */
  readonly live: boolean;
  get(url: string): Promise<PapHttpResponse>;
}

/** Transport hors ligne : `index.json` associe une URL à un fichier HTML et un statut. */
export class PapFixtureTransport implements PapTransport {
  readonly live = false;
  readonly urls: string[] = [];

  constructor(private readonly dir: string) {}

  async get(url: string): Promise<PapHttpResponse> {
    this.urls.push(url);
    const index = JSON.parse(await readFile(path.join(this.dir, 'index.json'), 'utf8')) as Record<string, { file: string; status?: number }>;
    const entry = index[url];
    if (!entry) throw new Error(`fixture absente pour ${url}`);
    return { status: entry.status ?? 200, contentType: 'text/html; charset=utf-8', body: await readFile(path.join(this.dir, entry.file), 'utf8') };
  }
}

/**
 * Transport réel vers pap.fr : simple lecture des pages de recherche que l'utilisateur fournit,
 * avec les garde-fous du client (délai, budget, robots.txt). Voir docs/decisions/0006-tests-reels.md.
 */
export class LivePapTransport implements PapTransport {
  readonly live = true;

  constructor(
    private readonly http: GuardedHttpClient,
    private readonly recorder?: ResponseRecorder,
  ) {}

  async get(url: string): Promise<PapHttpResponse> {
    const res = await this.http.request(url, { method: 'GET', headers: { accept: 'text/html' } });
    await this.recorder?.save(url, res);
    return { status: res.status, contentType: res.contentType, body: res.text };
  }
}
