import { readFile } from 'node:fs/promises';
import path from 'node:path';

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
 * Pas de transport réel : l'accès à pap.fr n'est pas qualifié (conditions d'utilisation, droits de
 * réutilisation). Voir docs/decisions/0005-pap.md.
 */
export function createLivePapTransport(): never {
  throw new Error('Transport PAP réel non disponible : accès non qualifié (voir docs/decisions/0005-pap.md)');
}
