import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AdemeDpeConnector, AdemeFixtureTransport, FixtureTransport, LeboncoinConnector, PapConnector, PapFixtureTransport,
} from '@imo/connectors';
import type { Connector } from '@imo/contracts';
import type { Db } from '@imo/db';
import { runCollection } from '@imo/domain';
import { FIXTURES, resetDb, setupDb } from '../helpers/db.ts';

/**
 * Rejoue les réponses réelles enregistrées par `worker … --record tests/fixtures/<source>/reel-<date>`.
 * Ces dossiers restent hors Git : sans enregistrement local, ce fichier ne teste rien.
 * Une sonde bloquée (CAPTCHA, 403) est un résultat valable ; un format illisible ne l'est pas.
 */
interface Recording { source: 'ademe' | 'leboncoin' | 'pap'; dir: string; scope: any; pages: number }

const recordings: Recording[] = (['ademe', 'leboncoin', 'pap'] as const).flatMap((source) => {
  const base = path.join(FIXTURES, source);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((d) => d.startsWith('reel-') && existsSync(path.join(base, d, 'scope.json')))
    .map((d) => {
      const dir = path.join(base, d);
      const { scope } = JSON.parse(readFileSync(path.join(dir, 'scope.json'), 'utf8'));
      const pages = Object.keys(JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'))).length;
      return { source, dir, scope, pages };
    });
});

function connectorFor(r: Recording): Connector<any> {
  if (r.source === 'ademe') return new AdemeDpeConnector(new AdemeFixtureTransport(r.dir));
  if (r.source === 'leboncoin') return new LeboncoinConnector(new FixtureTransport(r.dir));
  return new PapConnector(new PapFixtureTransport(r.dir));
}

let db: Db;
beforeAll(async () => { db = await setupDb(); });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetDb(db); });

describe.skipIf(recordings.length === 0)('rejeu des réponses réelles enregistrées', () => {
  for (const r of recordings) {
    it(`${r.source} · ${path.basename(r.dir)} (${r.pages} réponse(s))`, async () => {
      const run = await runCollection(db, connectorFor(r), r.scope, { maxPages: r.pages, retries: 0 });
      const c = run.counts;
      console.log(`${r.source}/${path.basename(r.dir)} : ${run.status} · vues ${c.seen} · créées ${c.created} · rejetées ${c.rejected}` +
        run.errors.map((e) => `\n  ${e.kind} : ${e.message}`).join(''));

      if (run.status === 'blocked') return; // refus de la source : résultat à documenter, pas un défaut de lecture
      expect(run.errors.filter((e) => e.kind === 'unexpected_schema')).toEqual([]);
      expect(c.seen).toBeGreaterThan(0);
      // Plus de 5 % de lignes rejetées signale une normalisation fondée sur une mauvaise hypothèse.
      expect(c.rejected / (c.seen + c.rejected)).toBeLessThan(0.05);

      // Rejouer le même enregistrement ne doit rien réécrire.
      const replay = await runCollection(db, connectorFor(r), r.scope, { maxPages: r.pages, retries: 0 });
      expect(replay.counts).toMatchObject({ created: 0, updated: 0 });
    }, 600_000);
  }
});
