BEGIN;

CREATE TABLE IF NOT EXISTS knowledge_repair_drafts (
  draft_id uuid PRIMARY KEY,
  issue_id uuid NOT NULL REFERENCES issue_cases(issue_id),
  status text NOT NULL CHECK (status IN ('generating','draft_ready','validating','validation_failed','ready_to_publish','publishing','published','failed')),
  target_kind text CHECK (target_kind IN ('answer_card','knowledge_page','retrieval_rule','system_fix')),
  target_domain text CHECK (target_domain IN ('coremail-professional','presales-general')),
  target_path text,
  base_git_revision char(40),
  model text NOT NULL CHECK (model = 'deepseek_v4_flash'),
  encrypted_payload jsonb NOT NULL,
  created_by text NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_repair_drafts_issue_idx
  ON knowledge_repair_drafts(issue_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_repair_draft_per_issue_idx
  ON knowledge_repair_drafts(issue_id)
  WHERE status NOT IN ('published','failed');

CREATE TABLE IF NOT EXISTS repair_validation_runs (
  validation_id uuid PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES knowledge_repair_drafts(draft_id),
  issue_id uuid NOT NULL REFERENCES issue_cases(issue_id),
  status text NOT NULL CHECK (status IN ('queued','running','passed','failed')),
  total_cases integer NOT NULL DEFAULT 0 CHECK (total_cases >= 0),
  passed_cases integer NOT NULL DEFAULT 0 CHECK (passed_cases >= 0 AND passed_cases <= total_cases),
  model text NOT NULL CHECK (model = 'deepseek_v4_flash'),
  encrypted_payload jsonb NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS repair_validation_runs_draft_idx
  ON repair_validation_runs(draft_id, created_at DESC);

CREATE TABLE IF NOT EXISTS repair_publications (
  publication_id uuid PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES knowledge_repair_drafts(draft_id),
  issue_id uuid NOT NULL REFERENCES issue_cases(issue_id),
  status text NOT NULL CHECK (status IN ('pending','publishing','published','failed','rolled_back')),
  target_domain text NOT NULL CHECK (target_domain IN ('coremail-professional','presales-general')),
  target_path text NOT NULL,
  base_git_revision char(40) NOT NULL,
  resulting_git_revision char(40),
  catalog_hash char(64),
  snapshot_release_id text,
  previous_release_id text,
  created_by text NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  rolled_back_at timestamptz
);
CREATE INDEX IF NOT EXISTS repair_publications_draft_idx
  ON repair_publications(draft_id, created_at DESC);

COMMIT;
