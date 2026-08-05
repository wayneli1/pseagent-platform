BEGIN;

CREATE TABLE IF NOT EXISTS repair_batches (
  batch_id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('queued','publishing','published','failed','rolled_back')),
  item_count integer NOT NULL CHECK (item_count > 0 AND item_count <= 50),
  domains jsonb NOT NULL,
  catalog_hash char(64),
  snapshot_release_id text,
  previous_release_id text,
  created_by text NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  rolled_back_at timestamptz
);
CREATE INDEX IF NOT EXISTS repair_batches_created_idx
  ON repair_batches(created_at DESC);

ALTER TABLE repair_publications
  ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES repair_batches(batch_id),
  ADD COLUMN IF NOT EXISTS remote_sync_status text NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS remote_name text,
  ADD COLUMN IF NOT EXISTS remote_branch text;

ALTER TABLE repair_publications
  DROP CONSTRAINT IF EXISTS repair_publications_remote_sync_status_check;
ALTER TABLE repair_publications
  ADD CONSTRAINT repair_publications_remote_sync_status_check
  CHECK (remote_sync_status IN ('not_requested','pending','pushing','synced','failed','compensated'));

CREATE INDEX IF NOT EXISTS repair_publications_batch_idx
  ON repair_publications(batch_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_repair_publication_per_draft_idx
  ON repair_publications(draft_id)
  WHERE status IN ('pending','publishing','published');

COMMIT;
