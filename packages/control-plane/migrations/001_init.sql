-- Control-plane store. Key columns hold what we query, filter, sort, or
-- compare-and-set on; `data` holds the full shared-types object, so new
-- optional fields don't need a migration.

CREATE TABLE installations (
  installation_id bigint PRIMARY KEY,
  installed_at    timestamptz NOT NULL,
  data            jsonb NOT NULL
);

CREATE TABLE repositories (
  id              text PRIMARY KEY,
  installation_id bigint NOT NULL REFERENCES installations (installation_id) ON DELETE CASCADE,
  full_name       text NOT NULL,
  data            jsonb NOT NULL
);
CREATE UNIQUE INDEX repositories_full_name_lower ON repositories (lower(full_name));
CREATE INDEX repositories_installation ON repositories (installation_id);

-- No foreign key to repositories: a repo removed from an installation keeps
-- its stages, runs, and findings.
CREATE TABLE stages (
  id            text PRIMARY KEY,
  repository_id text NOT NULL,
  branch        text NOT NULL,
  sort_order    integer NOT NULL,
  cursor_sha    text,
  data          jsonb NOT NULL
);
CREATE INDEX stages_repository_branch ON stages (repository_id, branch);

CREATE TABLE run_counters (
  stage_id    text PRIMARY KEY,
  last_number integer NOT NULL
);

CREATE TABLE runs (
  id            text PRIMARY KEY,
  repository_id text NOT NULL,
  stage_id      text NOT NULL,
  number        integer NOT NULL,
  status        text NOT NULL,
  started_at    timestamptz NOT NULL,
  data          jsonb NOT NULL
);
CREATE INDEX runs_stage_number ON runs (stage_id, number DESC);
CREATE INDEX runs_repository_started ON runs (repository_id, started_at DESC);

CREATE TABLE findings (
  id            text PRIMARY KEY,
  run_id        text NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  repository_id text NOT NULL,
  severity_rank smallint NOT NULL,
  reported_at   timestamptz NOT NULL,
  data          jsonb NOT NULL
);
CREATE INDEX findings_run_order ON findings (run_id, severity_rank, reported_at DESC);
CREATE INDEX findings_repository_order ON findings (repository_id, severity_rank, reported_at DESC);

CREATE TABLE manifest_snapshots (
  repository_id text NOT NULL,
  commit_sha    text NOT NULL,
  loaded_at     timestamptz NOT NULL,
  data          jsonb NOT NULL,
  PRIMARY KEY (repository_id, commit_sha)
);
CREATE INDEX manifest_snapshots_latest ON manifest_snapshots (repository_id, loaded_at DESC);

CREATE TABLE webhook_deliveries (
  id          text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_received ON webhook_deliveries (received_at);
