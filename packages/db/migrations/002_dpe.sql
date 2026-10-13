-- Diagnostics de performance énergétique (ADEME). Objets distincts des annonces.
CREATE TABLE dpe_records (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id              text NOT NULL REFERENCES sources(id),
  dpe_number             text NOT NULL,
  first_seen_at          timestamptz NOT NULL,
  last_seen_at           timestamptz NOT NULL,
  last_seen_run_id       uuid NOT NULL REFERENCES collection_runs(id),
  current_version_id     uuid,
  -- Remplacement : renseigné quand un DPE ultérieur déclare remplacer celui-ci.
  replaced_by_dpe_number text,
  -- Copie des valeurs courantes pour la recherche ; la vérité reste dans dpe_record_versions.
  replaces_dpe_number    text,
  building_type          text,
  living_area            numeric,
  energy_class           text,
  ges_class              text,
  established_at         date,
  received_at            date,
  last_modified_at       date,
  insee_code             text,
  postal_code            text,
  raw_postal_code        text,
  address_ban            text,
  geocoding_status       text,
  location               geography(Point, 4326),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, dpe_number)
);
CREATE INDEX dpe_records_commune ON dpe_records (insee_code, received_at DESC);
CREATE INDEX dpe_records_raw_postal ON dpe_records (raw_postal_code);
CREATE INDEX dpe_records_location ON dpe_records USING gist (location);
CREATE INDEX dpe_records_replaces ON dpe_records (replaces_dpe_number) WHERE replaces_dpe_number IS NOT NULL;

CREATE TABLE dpe_record_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dpe_record_id  uuid NOT NULL REFERENCES dpe_records(id) ON DELETE CASCADE,
  run_id         uuid NOT NULL REFERENCES collection_runs(id),
  content_hash   text NOT NULL,
  data           jsonb NOT NULL,
  parser_version text NOT NULL,
  observed_at    timestamptz NOT NULL,
  UNIQUE (dpe_record_id, run_id)
);
ALTER TABLE dpe_records ADD CONSTRAINT dpe_records_current_version_fk FOREIGN KEY (current_version_id) REFERENCES dpe_record_versions(id);

CREATE TABLE dpe_observations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dpe_record_id uuid NOT NULL REFERENCES dpe_records(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES collection_runs(id),
  version_id    uuid NOT NULL REFERENCES dpe_record_versions(id),
  observed_at   timestamptz NOT NULL,
  raw_hash      text NOT NULL,
  UNIQUE (dpe_record_id, run_id)
);
