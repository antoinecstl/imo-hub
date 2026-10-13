import type { ConnectorErrorKind, ConnectorResult } from './collection.ts';

export interface ConnectorCapabilities {
  detail: boolean;
  /**
   * Le connecteur interroge réellement un service distant. Dans ce cas, la source doit avoir
   * `access_status = 'authorized'` en base avant toute collecte.
   */
  requiresAuthorizedAccess: boolean;
}

export interface SourceDescriptor {
  id: string;
  name: string;
  kind: 'portal' | 'file_import' | 'public_data';
  /**
   * Licence ouverte couvrant la réutilisation (ex. « Licence Ouverte 2.0 »). Une source sous licence
   * ouverte est enregistrée avec access_status = 'authorized' et la licence en note de droits.
   */
  openLicence?: string;
}

export interface ConnectorHealth {
  ok: boolean;
  detail: string;
}

/**
 * Contrat commun des connecteurs. `discover` renvoie UNE page : le pipeline enregistre
 * le curseur après chaque page, ce qui rend la collecte reprenable.
 */
export interface Connector<Scope = Record<string, unknown>> {
  readonly source: SourceDescriptor;
  readonly version: string;
  readonly capabilities: ConnectorCapabilities;
  scopeKey(scope: Scope): string;
  /** La collecte de ce périmètre est-elle censée être exhaustive (base d'un constat d'absence) ? */
  exhaustive(scope: Scope): Promise<boolean>;
  /** Clé d'idempotence d'une collecte (ex. empreinte d'un fichier) ; null si chaque exécution est nouvelle. */
  runKey(scope: Scope): Promise<string | null>;
  /** Date d'observation imposée par la donnée (ex. date d'extraction d'un fichier), sinon null. */
  observedAt(scope: Scope): Promise<Date | null>;
  discover(scope: Scope, cursor: string | null, page: number): Promise<ConnectorResult>;
  health(): Promise<ConnectorHealth>;
}

/** Erreur typée qu'un transport peut lever ; `blocking` arrête la collecte de la source. */
export class SourceAccessError extends Error {
  constructor(
    readonly kind: ConnectorErrorKind,
    message: string,
    readonly blocking: boolean,
  ) {
    super(message);
    this.name = 'SourceAccessError';
  }
}
