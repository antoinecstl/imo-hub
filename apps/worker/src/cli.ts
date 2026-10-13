import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AdemeDpeConnector, AdemeFixtureTransport, FileImportConnector, FixtureTransport, GuardedHttpClient, HttpAdemeTransport,
  LeboncoinConnector, LiveLbcTransport, LivePapTransport, PapConnector, PapFixtureTransport, ResponseRecorder,
} from '@imo/connectors';
import { createPool, migrate } from '@imo/db';
import { runCollection, type RunSummary } from '@imo/domain';

const USAGE = `usage :
  worker import <fichier.csv|json> --source <id> [--name <libellé>] [--observed-at <ISO 8601>] [--exhaustive]
  worker leboncoin-fixtures <dossier> --locations 56000,56860 [--max-pages N] [--resume <runId>]
  worker pap-fixtures <dossier> --search-urls <url1>,<url2> [--max-pages N] [--resume <runId>]
  worker ademe --insee 06088,78551 [--postal-raw 06000,06100,78100,78112] [--since YYYY-MM-DD] [--fixtures <dossier>] [--record <dossier>] [--resume <runId>]

Sondes réelles (source à autoriser d'abord ; 1 page par défaut, 5 s entre appels, robots.txt respecté, arrêt au premier refus) :
  worker source list
  worker source authorize <leboncoin|pap> --note "<décision et date>"
  worker source block <id>
  worker leboncoin --locations 06000,06100 [--max-pages N] [--record <dossier>]
  worker pap --search-urls <url Nice>,<url Saint-Germain> [--max-pages N] [--record <dossier>]`;

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
    record: { type: 'string' },
    note: { type: 'string' },
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
    const recorder = values.record ? new ResponseRecorder(path.resolve(values.record)) : undefined;
    const transport = values.fixtures ? new AdemeFixtureTransport(path.resolve(values.fixtures)) : new HttpAdemeTransport({ recorder });
    const scope = { inseeCodes: list(values.insee), rawPostalCodes: list(values['postal-raw']), modifiedSince: values.since };
    print(await runCollection(db, new AdemeDpeConnector(transport), scope, {
      maxPages: values['max-pages'] ? Number(values['max-pages']) : undefined,
      resumeRunId: values.resume,
    }));
  } else if ((command === 'leboncoin' && values.locations) || (command === 'pap' && values['search-urls'])) {
    // Sonde réelle : peu de pages, budget de requêtes égal aux pages, réponses enregistrées si demandé.
    const maxPages = values['max-pages'] ? Number(values['max-pages']) : 1;
    const http = new GuardedHttpClient({ minIntervalMs: 5000, maxRequests: maxPages, respectRobots: true });
    const recorder = values.record ? new ResponseRecorder(path.resolve(values.record)) : undefined;
    const run = command === 'leboncoin'
      ? runCollection(db, new LeboncoinConnector(new LiveLbcTransport(http, recorder)), { locations: values.locations!.split(',').filter(Boolean) }, { maxPages, resumeRunId: values.resume, retries: 0 })
      : runCollection(db, new PapConnector(new LivePapTransport(http, recorder)), { searchUrls: values['search-urls']!.split(',').filter(Boolean) }, { maxPages, resumeRunId: values.resume, retries: 0 });
    print(await run);
    console.log(`  requêtes envoyées : ${http.requestsMade}${values.record ? ` · réponses enregistrées dans ${values.record}` : ''}`);
  } else if (command === 'source' && positionals[0] === 'list') {
    const { rows } = await db.query('SELECT id, kind, enabled, access_status, rights_note FROM sources ORDER BY id');
    console.table(rows);
  } else if (command === 'source' && positionals[0] === 'authorize' && positionals[1]) {
    if (!values.note) throw new Error('--note obligatoire : indiquer la décision qui autorise l’accès réel et sa date');
    const { rowCount } = await db.query(
      `INSERT INTO sources (id, name, kind, connector_version, access_status, rights_note)
       VALUES ($1, $1, 'portal', 'n/a', 'authorized', $2)
       ON CONFLICT (id) DO UPDATE SET access_status = 'authorized', rights_note = $2, updated_at = now()`,
      [positionals[1], values.note],
    );
    console.log(`${positionals[1]} autorisée (${rowCount} ligne) : ${values.note}`);
  } else if (command === 'source' && positionals[0] === 'block' && positionals[1]) {
    await db.query(`UPDATE sources SET access_status = 'blocked', updated_at = now() WHERE id = $1`, [positionals[1]]);
    console.log(`${positionals[1]} bloquée`);
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
} finally {
  await db.end();
}
