import path from 'node:path';
import { parseArgs } from 'node:util';
import { FileImportConnector, FixtureTransport, LeboncoinConnector } from '@imo/connectors';
import { createPool, migrate } from '@imo/db';
import { runCollection, type RunSummary } from '@imo/domain';

const USAGE = `usage :
  worker import <fichier.csv|json> --source <id> [--name <libellé>] [--observed-at <ISO 8601>] [--exhaustive]
  worker leboncoin-fixtures <dossier> --locations 56000,56860 [--max-pages N] [--resume <runId>]

Le connecteur Leboncoin n'a pas de transport réel : seules les fixtures hors ligne sont disponibles.`;

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
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
} finally {
  await db.end();
}
