-- Socle de la plateforme de données : sources, collectes, annonces, observations, snapshots, événements.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE sources (
  id                text PRIMARY KEY,
  name              text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('portal', 'file_import', 'public_data')),
  enabled           boolean NOT NULL DEFAULT true,
  connector_version text NOT NULL,
  -- Statut de validation de l'accès réel : tant qu'il n'est pas 'authorized', aucune collecte distante.
  access_status     text NOT NULL DEFAULT 'unverified' CHECK (access_status IN ('unverified', 'authorized', 'refused', 'blocked')),
  rights_note       text,
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE collection_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         text NOT NULL REFERENCES sources(id),
  scope_key         text NOT NULL,
  scope             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL CHECK (status IN ('running', 'complete', 'partial', 'blocked', 'failed')),
  exhaustive        boolean NOT NULL DEFAULT false,
  idempotency_key   text,
  connector_version text NOT NULL,
  -- Moment auquel la donnée a été observée à la source (date d'extraction pour un fichier).
  observed_at       timestamptz NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  pages_expected    integer,
  pages_fetched     integer NOT NULL DEFAULT 0,
  cursor            text,
  items_seen        integer NOT NULL DEFAULT 0,
  items_created     integer NOT NULL DEFAULT 0,
  items_updated     integer NOT NULL DEFAULT 0,
  items_unchanged   integer NOT NULL DEFAULT 0,
  items_rejected    integer NOT NULL DEFAULT 0,
  errors            jsonb NOT NULL DEFAULT '[]'::jsonb,
  rejected          jsonb NOT NULL DEFAULT '[]'::jsonb,
  block_reason      text
);
-- Un même fichier ou une même clé de reprise ne produit qu'une collecte.
CREATE UNIQUE INDEX collection_runs_idempotency ON collection_runs (source_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX collection_runs_source_started ON collection_runs (source_id, started_at DESC);

CREATE TABLE listings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id            text NOT NULL REFERENCES sources(id),
  external_id          text NOT NULL,
  scope_key            text NOT NULL,
  first_seen_at        timestamptz NOT NULL,
  last_seen_at         timestamptz NOT NULL,
  last_seen_run_id     uuid NOT NULL REFERENCES collection_runs(id),
  current_snapshot_id  uuid,
  -- 'seen' : vue lors de la dernière collecte exploitable ; 'not_seen' : absente de collectes complètes successives.
  -- Jamais 'retirée' ni 'vendue' : ce sont des interprétations métier (chantier 2).
  presence_status      text NOT NULL DEFAULT 'seen' CHECK (presence_status IN ('seen', 'not_seen')),
  missed_complete_runs integer NOT NULL DEFAULT 0,
  -- Copie des valeurs courantes, pour la recherche. La vérité reste dans listing_snapshots.
  source_url           text,
  transaction_type     text,
  property_type        text,
  seller_type          text,
  title                text,
  price                integer,
  surface_value        numeric,
  rooms                integer,
  city                 text,
  postal_code          text,
  energy_class         text,
  location             geography(Point, 4326),
  source_published_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id)
);
CREATE INDEX listings_search ON listings (postal_code, transaction_type, property_type, price);
CREATE INDEX listings_last_seen ON listings (last_seen_at DESC);
CREATE INDEX listings_location ON listings USING gist (location);

CREATE TABLE listing_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL REFERENCES collection_runs(id),
  content_hash    text NOT NULL,
  data            jsonb NOT NULL,
  parser_version  text NOT NULL,
  observed_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Une collecte ne produit qu'un snapshot par annonce (rejouer une page reprise ne duplique rien).
  UNIQUE (listing_id, run_id)
);
CREATE INDEX listing_snapshots_listing ON listing_snapshots (listing_id, observed_at DESC);
ALTER TABLE listings ADD CONSTRAINT listings_current_snapshot_fk FOREIGN KEY (current_snapshot_id) REFERENCES listing_snapshots(id);

CREATE TABLE listing_observations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id    uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES collection_runs(id),
  snapshot_id   uuid NOT NULL REFERENCES listing_snapshots(id),
  observed_at   timestamptz NOT NULL,
  -- Empreinte de la donnée brute, et extrait minimisé seulement si les droits le permettent.
  raw_hash      text NOT NULL,
  raw_excerpt   jsonb,
  UNIQUE (listing_id, run_id)
);
CREATE INDEX listing_observations_listing ON listing_observations (listing_id, observed_at DESC);

CREATE TABLE listing_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id   uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL REFERENCES collection_runs(id),
  kind         text NOT NULL CHECK (kind IN ('appeared', 'price_changed', 'modified', 'not_seen', 'reappeared')),
  observed_at  timestamptz NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (listing_id, run_id, kind)
);
CREATE INDEX listing_events_listing ON listing_events (listing_id, observed_at DESC);
