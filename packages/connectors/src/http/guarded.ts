import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SourceAccessError } from '@imo/contracts';

/**
 * Client HTTP pour les collectes réelles, volontairement lent et borné :
 * - un appel à la fois, espacés d'au moins `minIntervalMs` ;
 * - un budget d'appels par processus (`maxRequests`), pour les sondes ;
 * - respect du robots.txt de l'hôte (règles « User-agent: * ») si `respectRobots` ;
 * - un User-Agent qui dit qui nous sommes. Aucun cookie ni en-tête emprunté à une application :
 *   si la source refuse, le refus est le résultat.
 */
export interface GuardedHttpOptions {
  minIntervalMs?: number;
  maxRequests?: number;
  timeoutMs?: number;
  userAgent?: string;
  respectRobots?: boolean;
}

export interface HttpResult {
  status: number;
  contentType: string;
  text: string;
}

/** Budget épuisé : arrêt volontaire, la collecte reste reprenable (pas de nouvelle tentative). */
export class RequestBudgetExceeded extends SourceAccessError {
  constructor(max: number) {
    super('interrupted', `budget de ${max} requête(s) atteint : arrêt volontaire de la sonde`, false);
  }
}

/** robots.txt interdit le chemin : la source est arrêtée. */
export class RobotsDisallowed extends SourceAccessError {
  constructor(url: string) {
    super('forbidden', `robots.txt interdit ${url}`, true);
  }
}

export const DEFAULT_USER_AGENT = 'imo-hub/0.1 (prototype de veille immobilière ; collecte limitée)';

export class GuardedHttpClient {
  private last = 0;
  private count = 0;
  private readonly robots = new Map<string, string[]>();

  constructor(private readonly opts: GuardedHttpOptions = {}) {}

  get requestsMade() {
    return this.count;
  }

  private async disallowed(url: URL): Promise<boolean> {
    if (!this.opts.respectRobots) return false;
    let rules = this.robots.get(url.origin);
    if (!rules) {
      rules = [];
      try {
        const res = await this.raw(new URL('/robots.txt', url.origin).toString(), { method: 'GET' }, false);
        if (res.status === 200) rules = parseRobots(res.text);
      } catch {
        // robots.txt injoignable : on ne présume pas d'interdiction, la requête suivante échouera d'elle-même.
      }
      this.robots.set(url.origin, rules);
    }
    const target = url.pathname + url.search;
    return rules.some((prefix) => prefix !== '' && target.startsWith(prefix));
  }

  private async raw(url: string, init: RequestInit, counted: boolean): Promise<HttpResult> {
    if (counted) {
      const max = this.opts.maxRequests ?? Infinity;
      if (this.count >= max) throw new RequestBudgetExceeded(max);
      this.count += 1;
    }
    const wait = this.last + (this.opts.minIntervalMs ?? 5000) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    const res = await fetch(url, {
      ...init,
      redirect: 'manual',
      headers: { 'user-agent': this.opts.userAgent ?? DEFAULT_USER_AGENT, 'accept-language': 'fr-FR,fr;q=0.9', ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    return { status: res.status, contentType: res.headers.get('content-type') ?? '', text: await res.text() };
  }

  async request(url: string, init: RequestInit = { method: 'GET' }): Promise<HttpResult> {
    if (await this.disallowed(new URL(url))) throw new RobotsDisallowed(url);
    return this.raw(url, init, true);
  }
}

/** Préfixes interdits pour « User-agent: * » (lecture simple, suffisante pour une sonde). */
export function parseRobots(text: string): string[] {
  const out: string[] = [];
  let applies = false;
  let inAgents = false;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key!.toLowerCase() === 'user-agent') {
      if (!inAgents) applies = false;
      inAgents = true;
      if (value === '*') applies = true;
    } else {
      inAgents = false;
      if (applies && key!.toLowerCase() === 'disallow') out.push(value!.replace(/\*.*$/, ''));
    }
  }
  return out;
}

/**
 * Enregistre chaque réponse réelle dans un dossier au format des transports de fixtures
 * (`index.json` + un fichier par réponse), pour la rejouer ensuite dans les tests.
 */
export class ResponseRecorder {
  private n = 0;

  constructor(private readonly dir: string) {}

  async save(key: string, res: { status: number; contentType: string; text: string }) {
    await mkdir(this.dir, { recursive: true });
    const indexPath = path.join(this.dir, 'index.json');
    let index: Record<string, unknown> = {};
    try {
      index = JSON.parse(await readFile(indexPath, 'utf8'));
    } catch {
      // premier enregistrement
    }
    this.n += 1;
    const isJson = res.contentType.includes('json');
    const file = `reponse-${String(this.n).padStart(3, '0')}.${isJson ? 'json' : 'html'}`;
    await writeFile(path.join(this.dir, file), res.text);
    index[key] = { file, status: res.status, contentType: res.contentType, recordedAt: new Date().toISOString() };
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }
}
