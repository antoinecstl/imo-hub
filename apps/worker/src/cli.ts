import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AdemeDpeConnector, AdemeFixtureTransport, FileImportConnector, FixtureTransport, HttpAdemeTransport, LeboncoinConnector,
  PapConnector, PapFixtureTransport,
} from '@imo/connectors';
import { createPool, migrate } from '@imo/db';
import { runCollection, type RunSummary } from '@imo/domain';

const USAGE = `usage :
  worker import <fichier.csv|json> --source <id> [--name <libellé>] [--observed-at <ISO 8601>] [--exhaustive]
  worker leboncoin-fixtures <dossier> --locations 56000,56860 [--max-pages N] [--resume <runId>]
  worker pap-fixtures <dossier> --search-urls <url1>,<url2> [--max-pages N] [--resume <runId>]
  worker ademe --insee 06088,78551 [--postal-raw 06000,06100,78100,78112] [--since YYYY-MM-DD] [--fixtures <dossier>] [--resume <runId>]

Les connecteurs Leboncoin et PAP n'ont pas de transport réel : seules les fixtures hors ligne sont disponibles ; l'import ADEME interroge l'API publique.`;

function print(s: RunSummary) {
  const c = s.counts;
  console.log(
    `${s.sourceId} · collecte ${s.runId} · ${s.status}${s.alreadyDone ? ' (déjà importée, rien réécrit)' : ''}\n` +
      `  pages ${s.pagesFetched} · vues ${c.seen} · créées ${c.created} · modifiées ${c.updated} · inchangées ${c.unchanged} · rejetées ${c.rejected}`,
  );
  if (s.blockReason) console.log(`  blocage : ${s.blockReason}`);
  for (const e of s.errors) console.log(`  erreur ${e.kind} : ${e.message}`);
}

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    source: { type: 'string' },
    name: { type: 'string' },
    'observed-at': { type: 'string' },
    exhaustive: { type: 'boolean' },
    locations: { type: 'string' },
    'max-pages': { type: 'string' },
    resume: { type: 'string' },
    'search-urls': { type: 'string' },
    insee: { type: 'string' },
    'postal-raw': { type: 'string' },
    since: { type: 'string' },
    fixtures: { type: 'string' },
  },
});

const db = createPool();
try {
  await migrate(db);
  if (command === 'import' && positionals[0] && values.source) {
    const scope = {
      filePath: path.resolve(positionals[0]),
      sourceId: values.source,
      sourceName: values.name,
      observedAt: values['observed-at'],
      exhaustive: values.exhaustive,
    };
    print(await runCollection(db, new FileImportConnector(scope), scope));
  } else if (command === 'leboncoin-fixtures' && positionals[0]) {
    const connector = new LeboncoinConnector(new FixtureTransport(path.resolve(positionals[0])));
    const scope = { locations: (values.locations ?? '').split(',').filter(Boolean) };
    print(await runCollection(db, connector, scope, {
      maxPages: values['max-pages'] ? Number(values['max-pages']) : undefined,
      resumeRunId: values.resume,
    }));
  } else if (command === 'pap-fixtures' && positionals[0] && values['search-urls']) {
    const connector = new PapConnector(new PapFixtureTransport(path.resolve(positionals[0])));
    const scope = { searchUrls: values['search-urls'].split(',').filter(Boolean) };
    print(await runCollection(db, connector, scope, {
      maxPages: values['max-pages'] ? Number(values['max-pages']) : undefined,
      resumeRunId: values.resume,
    }));
  } else if (command === 'ademe' && values.insee) {
    const list = (v?: string) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const transport = values.fixtures ? new AdemeFixtureTransport(path.resolve(values.fixtures)) : new HttpAdemeTransport();
    const scope = { inseeCodes: list(values.insee), rawPostalCodes: list(values['postal-raw']), modifiedSince: values.since };
    print(await runCollection(db, new AdemeDpeConnector(transport), scope, {
      maxPages: values['max-pages'] ? Number(values['max-pages']) : undefined,
      resumeRunId: values.resume,
    }));
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
} finally {
  await db.end();
}
