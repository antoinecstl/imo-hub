import { z } from 'zod';
import { NormalizedDpe } from './dpe.ts';
import { NormalizedListing } from './listing.ts';

/**
 * Statuts terminaux d'une collecte :
 * - complete : toutes les pages prévues ont été parcourues sans erreur ;
 * - partial  : des annonces ont été collectées mais le périmètre n'est pas couvert entièrement
 *              (interruption, troncature, lignes rejetées) ;
 * - blocked  : la source refuse l'accès (403, 429 persistant, CAPTCHA/challenge). On s'arrête, sans contournement ;
 * - failed   : erreur technique ou format inattendu empêchant d'exploiter la source.
 * `running` n'existe que pendant l'exécution.
 */
export const RunStatus = z.enum(['running', 'complete', 'partial', 'blocked', 'failed']);
export type RunStatus = z.infer<typeof RunStatus>;
export type TerminalRunStatus = Exclude<RunStatus, 'running'>;

export const ConnectorErrorKind = z.enum([
  'network', 'timeout', 'http', 'rate_limited', 'challenge', 'forbidden', 'unexpected_schema', 'invalid_item', 'interrupted',
]);
export type ConnectorErrorKind = z.infer<typeof ConnectorErrorKind>;

export const ConnectorError = z.object({
  kind: ConnectorErrorKind,
  message: z.string(),
  page: z.number().int().nullable(),
  itemRef: z.string().nullable(),
  at: z.string().datetime({ offset: true }),
});
export type ConnectorError = z.infer<typeof ConnectorError>;

export const RejectedItem = z.object({ itemRef: z.string(), errors: z.array(z.string()) });
export type RejectedItem = z.infer<typeof RejectedItem>;

/** Résultat d'un appel `discover` : une page de la source. */
export const ConnectorResult = z.object({
  status: z.enum(['ok', 'blocked', 'failed']),
  listings: z.array(NormalizedListing),
  /** Diagnostics énergétiques, pour les connecteurs de DPE. */
  dpeRecords: z.array(NormalizedDpe).optional(),
  /** Empreinte et extrait minimisé de la donnée brute, indexés par externalId (ou numéro de DPE). */
  raw: z.record(z.object({ hash: z.string(), excerpt: z.unknown().nullable() })),
  rejected: z.array(RejectedItem),
  errors: z.array(ConnectorError),
  page: z.number().int().nonnegative(),
  /** Nombre de pages annoncé par la source, s'il est connu. */
  pagesExpected: z.number().int().nonnegative().nullable(),
  /** Curseur pour reprendre à la page suivante ; null quand la source n'a plus de page. */
  nextCursor: z.string().nullable(),
  /** La source signale plus de résultats que ce qu'elle laisse parcourir. */
  truncated: z.boolean(),
});
export type ConnectorResult = z.infer<typeof ConnectorResult>;

export const CollectionRun = z.object({
  id: z.string().uuid(),
  sourceId: z.string(),
  scopeKey: z.string(),
  scope: z.record(z.unknown()),
  status: RunStatus,
  /** La collecte couvre-t-elle tout le périmètre (base d'un éventuel constat d'absence) ? */
  exhaustive: z.boolean(),
  idempotencyKey: z.string().nullable(),
  connectorVersion: z.string(),
  observedAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
  pagesExpected: z.number().int().nullable(),
  pagesFetched: z.number().int(),
  cursor: z.string().nullable(),
  counts: z.object({
    seen: z.number().int(), created: z.number().int(), updated: z.number().int(),
    unchanged: z.number().int(), rejected: z.number().int(),
  }),
  errors: z.array(ConnectorError),
  blockReason: z.string().nullable(),
});
export type CollectionRun = z.infer<typeof CollectionRun>;
