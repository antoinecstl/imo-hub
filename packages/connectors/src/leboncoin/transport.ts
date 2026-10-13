import { readFile } from 'node:fs/promises';
import path from 'node:path';

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
 * Aucun transport réel n'est fourni à ce stade : l'accès à Leboncoin n'est pas qualifié
 * (conditions d'utilisation, droits de réutilisation, CAPTCHA signalé par le dépôt tiers).
 * Un transport réel ne sera écrit qu'après validation (cf. docs/decisions/0003-leboncoin.md),
 * et il devra s'arrêter sur tout refus ou challenge, sans tentative de contournement.
 */
export function createLiveTransport(): never {
  throw new Error('Transport Leboncoin réel non disponible : accès non qualifié (voir docs/decisions/0003-leboncoin.md)');
}
