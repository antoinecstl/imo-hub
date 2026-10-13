import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SourceAccessError } from '@imo/contracts';
import { FixtureTransport } from '../leboncoin/transport.ts';
import { LiveLbcTransport } from '../leboncoin/transport.ts';
import { LeboncoinConnector } from '../leboncoin/connector.ts';
import { GuardedHttpClient, parseRobots, RequestBudgetExceeded, ResponseRecorder, RobotsDisallowed } from './guarded.ts';

let server: Server;
let base: string;
const seen: { url: string; ua: string | undefined; at: number }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url!, ua: req.headers['user-agent'], at: Date.now() });
    if (req.url === '/robots.txt') return res.end('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /prive\nDisallow: /recherche?*tri=\n');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('client HTTP des collectes réelles', () => {
  it('lit les interdictions robots.txt applicables à tous', () => {
    expect(parseRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /prive\nAllow: /\n')).toEqual(['/prive']);
  });

  it('respecte robots.txt, espace les appels, se présente et tient son budget', async () => {
    const http = new GuardedHttpClient({ minIntervalMs: 150, maxRequests: 2, respectRobots: true });
    await expect(http.request(`${base}/prive/page`)).rejects.toBeInstanceOf(RobotsDisallowed);
    const a = await http.request(`${base}/annonces?p=1`);
    const b = await http.request(`${base}/annonces?p=2`);
    expect([a.status, b.status]).toEqual([200, 200]);
    const calls = seen.filter((s) => s.url.startsWith('/annonces'));
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(140);
    expect(calls[0]!.ua).toMatch(/^imo-hub/);
    const err = await http.request(`${base}/annonces?p=3`).catch((e) => e);
    expect(err).toBeInstanceOf(RequestBudgetExceeded);
    expect((err as SourceAccessError).blocking).toBe(false);
  });

  it('enregistre les réponses réelles et les rejoue comme fixtures', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'imo-rec-'));
    const recorder = new ResponseRecorder(dir);
    const page = { total: 1, max_pages: 1, ads: [{ list_id: 7, category_id: '9', price: [123000], url: 'https://www.leboncoin.fr/ad/ventes_immobilieres/7' }] };
    const fakeHttp = { request: async () => ({ status: 200, contentType: 'application/json; charset=utf-8', text: JSON.stringify(page) }) } as unknown as GuardedHttpClient;
    const live = new LeboncoinConnector(new LiveLbcTransport(fakeHttp, recorder));
    const first = await live.discover({ locations: ['06000'] }, null, 0);
    expect(first.listings[0]?.price).toBe(123000);
    const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
    expect(index.__first__).toMatchObject({ file: 'reponse-001.json', status: 200 });
    const replay = await new LeboncoinConnector(new FixtureTransport(dir)).discover({ locations: ['06000'] }, null, 0);
    expect(replay.listings).toEqual(first.listings);
  });

  it('un robots.txt interdisant la recherche bloque la source au lieu de réessayer', async () => {
    const http = { request: async () => { throw new RobotsDisallowed('https://x/recherche'); } } as unknown as GuardedHttpClient;
    const res = await new LeboncoinConnector(new LiveLbcTransport(http)).discover({ locations: ['06000'] }, null, 0);
    expect([res.status, res.errors[0]?.kind]).toEqual(['blocked', 'forbidden']);
  });
});
