import { createHash } from 'node:crypto';
import type { ConnectorError, ConnectorErrorKind } from '@imo/contracts';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** JSON stable (clés triées) pour calculer des empreintes reproductibles. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function connectorError(kind: ConnectorErrorKind, message: string, page: number | null, itemRef: string | null = null): ConnectorError {
  return { kind, message, page, itemRef, at: new Date().toISOString() };
}

const parisOffsetFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', timeZoneName: 'longOffset' });

function parisOffsetMinutes(utcMs: number): number {
  const name = parisOffsetFormatter.formatToParts(new Date(utcMs)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Convertit une date locale française « YYYY-MM-DD HH:mm:ss » en ISO 8601 UTC ; null si illisible. */
export function parisLocalToIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  // Deux passes pour tomber juste autour des changements d'heure.
  let utc = naive - parisOffsetMinutes(naive) * 60_000;
  utc = naive - parisOffsetMinutes(utc) * 60_000;
  return new Date(utc).toISOString();
}
