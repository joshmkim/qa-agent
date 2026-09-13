-- Control-plane settings edited from the web UI. One row per setting; the
-- fleet configuration lives under key 'fleet' as the shared-types FleetConfig.
-- A tenant/pipeline scope can be folded into the key later without a schema
-- change.
CREATE TABLE settings (
  key        text PRIMARY KEY,
  updated_at timestamptz NOT NULL DEFAULT now(),
  data       jsonb NOT NULL
);
