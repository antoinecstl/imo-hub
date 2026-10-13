import type { Connector, ConnectorError, ConnectorResult, RejectedItem, TerminalRunStatus } from '@imo/contracts';
import { withTransaction, type Db } from '@imo/db';
import { ingestListing } from './ingest.ts';

export interface RunOptions {
  /** Reprendre une collecte interrompue à partir de son dernier curseur. */
  resumeRunId?: string;
  /** Plafond de pages parcourues par exécution ; au-delà, la collecte est partielle. */
  maxPages?: number;
  /** Nombre de collectes complètes et exhaustives sans l'annonce avant de la marquer « non revue ». */
  notSeenThreshold?: number;
  /** Nouvelles tentatives sur erreur temporaire (réseau, 5xx). Un refus ou un challenge n'est jamais retenté. */
  retries?: number;
  retryBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface RunSummary {
  runId: string;
  sourceId: string;
  status: TerminalRunStatus;
  /** true si la collecte avait déjà été menée à bien (même fichier) : rien n'a été réécrit. */
  alreadyDone: boolean;
  pagesFetched: number;
  counts: { seen: number; created: number; updated: number; unchanged: number; rejected: number };
  errors: ConnectorError[];
  blockReason: string | null;
}

interface RunRow {
  id: string;
  status: string;
  scope_key: string;
  observed_at: Date;
  pages_fetched: number;
  cursor: string | null;
  errors: ConnectorError[];
  rejected: RejectedItem[];
  items_seen: number;
  items_created: number;
  items_updated: number;
  items_unchanged: number;
  items_rejected: number;
  block_reason: string | null;
}

const TRANSIENT = new Set(['network', 'timeout', 'http']);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function summary(row: RunRow, sourceId: string, alreadyDone: boolean): RunSummary {
  return {
    runId: row.id, sourceId, status: row.status as TerminalRunStatus, alreadyDone, pagesFetched: row.pages_fetched,
    counts: { seen: row.items_seen, created: row.items_created, updated: row.items_updated, unchanged: row.items_unchanged, rejected: row.items_rejected },
    errors: row.errors, blockReason: row.block_reason,
  };
}

export async function ensureSource(db: Db, connector: Connector<any>) {
  const { rows } = await db.query<{ enabled: boolean; access_status: string }>(
    `INSERT INTO sources (id, name, kind, connector_version) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET connector_version = EXCLUDED.connector_version, updated_at = now()
     RETURNING enabled, access_status`,
    [connector.source.id, connector.source.name, connector.source.kind, connector.version],
  );
  return rows[0]!;
}

/**
 * Exécute une collecte page par page. Chaque page est enregistrée dans sa propre transaction
 * avec le curseur suivant : une interruption laisse une collecte reprenable, jamais à moitié écrite.
 */
export async function runCollection<S>(db: Db, connector: Connector<S>, scope: S, opts: RunOptions = {}): Promise<RunSummary> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? defaultSleep;
  const retries = opts.retries ?? 2;
  const sourceId = connector.source.id;
  const source = await ensureSource(db, connector);
  const scopeKey = connector.scopeKey(scope);

  // 1. Retrouver ou créer la collecte.
  let run: RunRow;
  const idempotencyKey = opts.resumeRunId ? null : await connector.runKey(scope);
  const existing = opts.resumeRunId
    ? await db.query<RunRow>('SELECT * FROM collection_runs WHERE id = $1 AND source_id = $2', [opts.resumeRunId, sourceId])
    : idempotencyKey
      ? await db.query<RunRow>('SELECT * FROM collection_runs WHERE source_id = $1 AND idempotency_key = $2', [sourceId, idempotencyKey])
      : null;

  if (opts.resumeRunId && !existing?.rowCount) throw new Error(`collecte ${opts.resumeRunId} introuvable pour ${sourceId}`);
  if (existing?.rowCount) {
    run = existing.rows[0]!;
    // Collecte déjà menée jusqu'à la dernière page : on ne réécrit rien.
    const reachedEnd = run.status !== 'running' && run.pages_fetched > 0 && run.cursor === null;
    if (run.status === 'complete' || (reachedEnd && !opts.resumeRunId)) return summary(run, sourceId, true);
    await db.query(`UPDATE collection_runs SET status = 'running', finished_at = NULL, block_reason = NULL WHERE id = $1`, [run.id]);
  } else {
    const observedAt = (await connector.observedAt(scope)) ?? now();
    const { rows } = await db.query<RunRow>(
      `INSERT INTO collection_runs (source_id, scope_key, scope, status, idempotency_key, connector_version, observed_at)
       VALUES ($1, $2, $3, 'running', $4, $5, $6) RETURNING *`,
      [sourceId, scopeKey, JSON.stringify(scope), idempotencyKey, connector.version, observedAt],
    );
    run = rows[0]!;
  }

  // 2. Garde-fous d'accès : une source désactivée ou non qualifiée n'est pas interrogée.
  const refusal = !source.enabled
    ? 'source désactivée'
    : connector.capabilities.requiresAuthorizedAccess && source.access_status !== 'authorized'
      ? `accès réel non autorisé (access_status=${source.access_status})`
      : null;
  if (refusal) return finish(db, run.id, sourceId, 'blocked', { blockReason: refusal });

  // 3. Parcours des pages.
  let page = run.pages_fetched;
  let cursor = run.cursor;
  let hitError: ConnectorResult | null = null;
  let truncated = false;
  let cappedByUs = false;
  let rejected = run.items_rejected;
  const maxPages = opts.maxPages ?? Infinity;
  // Un curseur nul après au moins une page signifie que la collecte précédente avait atteint la fin.
  let finished = page > 0 && cursor === null;

  while (!finished) {
    if (page >= maxPages) {
      cappedByUs = true;
      break;
    }
    let result: ConnectorResult;
    let attempt = 0;
    for (;;) {
      try {
        result = await connector.discover(scope, cursor, page);
      } catch (err) {
        result = {
          status: 'failed', listings: [], raw: {}, rejected: [], page, pagesExpected: null, nextCursor: cursor, truncated: false,
          errors: [{ kind: 'network', message: (err as Error).message, page, itemRef: null, at: now().toISOString() }],
        };
      }
      const transient = result.status === 'failed' && result.errors.some((e) => TRANSIENT.has(e.kind));
      if (!transient || attempt >= retries) break;
      attempt += 1;
      await sleep((opts.retryBaseDelayMs ?? 1000) * 2 ** (attempt - 1));
    }
    if (result.status !== 'ok') {
      hitError = result;
      await appendErrors(db, run.id, result.errors);
      break;
    }

    const ctx = { runId: run.id, scopeKey, observedAt: run.observed_at, parserVersion: connector.version };
    await withTransaction(db, async (c) => {
      const counts = { seen: 0, created: 0, updated: 0, unchanged: 0 };
      for (const listing of result.listings) {
        const outcome = await ingestListing(c, listing, result.raw[listing.externalId]?.hash ?? '', ctx);
        if (outcome === 'duplicate_in_run') continue;
        counts.seen += 1;
        counts[outcome] += 1;
      }
      await c.query(
        `UPDATE collection_runs SET pages_fetched = pages_fetched + 1, cursor = $2,
           pages_expected = COALESCE($3, pages_expected),
           items_seen = items_seen + $4, items_created = items_created + $5, items_updated = items_updated + $6,
           items_unchanged = items_unchanged + $7, items_rejected = items_rejected + $8,
           rejected = rejected || $9::jsonb, errors = errors || $10::jsonb
         WHERE id = $1`,
        [run.id, result.nextCursor, result.pagesExpected, counts.seen, counts.created, counts.updated, counts.unchanged,
          result.rejected.length, JSON.stringify(result.rejected), JSON.stringify(result.errors)],
      );
    });
    rejected += result.rejected.length;
    truncated ||= result.truncated;
    page += 1;
    cursor = result.nextCursor;
    finished = cursor === null;
  }

  // 4. Statut final.
  let status: TerminalRunStatus;
  let blockReason: string | null = null;
  if (hitError?.status === 'blocked') {
    status = 'blocked';
    blockReason = hitError.errors.map((e) => e.message).join('; ');
  } else if (hitError) {
    status = page === 0 ? 'failed' : 'partial';
  } else if (truncated || cappedByUs || rejected > 0) {
    status = 'partial';
  } else {
    status = 'complete';
  }
  const exhaustive = status === 'complete' && (await connector.exhaustive(scope));
  const done = await finish(db, run.id, sourceId, status, { blockReason, exhaustive });

  // 5. Constat d'absence : seulement après une collecte complète ET exhaustive.
  //    Une panne, un blocage ou une collecte partielle ne fait jamais disparaître une annonce.
  if (exhaustive) await markUnseen(db, run.id, sourceId, scopeKey, run.observed_at, opts.notSeenThreshold ?? 2);
  return done;
}

async function appendErrors(db: Db, runId: string, errors: ConnectorError[]) {
  await db.query(`UPDATE collection_runs SET errors = errors || $2::jsonb WHERE id = $1`, [runId, JSON.stringify(errors)]);
}

async function finish(
  db: Db, runId: string, sourceId: string, status: TerminalRunStatus,
  extra: { blockReason?: string | null; exhaustive?: boolean },
): Promise<RunSummary> {
  const { rows } = await db.query<RunRow>(
    `UPDATE collection_runs SET status = $2, finished_at = now(), block_reason = $3, exhaustive = $4 WHERE id = $1 RETURNING *`,
    [runId, status, extra.blockReason ?? null, extra.exhaustive ?? false],
  );
  return summary(rows[0]!, sourceId, false);
}

async function markUnseen(db: Db, runId: string, sourceId: string, scopeKey: string, observedAt: Date, threshold: number) {
  await withTransaction(db, async (c) => {
    const { rows } = await c.query<{ id: string; missed_complete_runs: number; presence_status: string }>(
      `UPDATE listings SET missed_complete_runs = missed_complete_runs + 1, updated_at = now()
        WHERE source_id = $1 AND scope_key = $2 AND last_seen_run_id <> $3 AND last_seen_at < $4
        RETURNING id, missed_complete_runs, presence_status`,
      [sourceId, scopeKey, runId, observedAt],
    );
    for (const r of rows) {
      if (r.presence_status === 'seen' && r.missed_complete_runs >= threshold) {
        await c.query(`UPDATE listings SET presence_status = 'not_seen' WHERE id = $1`, [r.id]);
        await c.query(
          `INSERT INTO listing_events (listing_id, run_id, kind, observed_at, payload) VALUES ($1, $2, 'not_seen', $3, $4)
           ON CONFLICT DO NOTHING`,
          [r.id, runId, observedAt, JSON.stringify({ missedCompleteRuns: r.missed_complete_runs })],
        );
      }
    }
  });
}

/** Exécute plusieurs sources de façon isolée : l'échec ou le blocage de l'une n'empêche pas les autres. */
export async function runSources(
  db: Db,
  jobs: { connector: Connector<any>; scope: unknown; options?: RunOptions }[],
): Promise<(RunSummary | { sourceId: string; status: 'failed'; error: string })[]> {
  const results = [];
  for (const job of jobs) {
    try {
      results.push(await runCollection(db, job.connector, job.scope, job.options));
    } catch (err) {
      results.push({ sourceId: job.connector.source.id, status: 'failed' as const, error: (err as Error).message });
    }
  }
  return results;
}
