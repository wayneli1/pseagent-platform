BEGIN;

CREATE TABLE IF NOT EXISTS feedback_cases (
  case_id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  pseudonymous_user_id char(64) NOT NULL,
  classification text NOT NULL CHECK (classification IN ('useful','incorrect','missing','evidence')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','triaged','in_review','resolved','rejected')),
  encrypted_payload jsonb NOT NULL,
  answer_status text NOT NULL,
  scope text,
  reference_count integer NOT NULL CHECK (reference_count >= 0),
  source text NOT NULL CHECK (source = 'lunkr_direct'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_cases_queue_idx ON feedback_cases(status, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_cases_user_idx ON feedback_cases(pseudonymous_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS card_revisions (
  revision_id uuid PRIMARY KEY,
  card_id text NOT NULL,
  domain text NOT NULL CHECK (domain IN ('coremail-professional','presales-general')),
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL,
  content jsonb NOT NULL,
  created_by text NOT NULL,
  base_git_revision char(40) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(card_id, revision)
);
CREATE INDEX IF NOT EXISTS card_revisions_status_idx ON card_revisions(domain, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS reviews (
  review_id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES card_revisions(revision_id),
  reviewer_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','changes_requested','rejected')),
  comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  UNIQUE(revision_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES card_revisions(revision_id),
  card_id text NOT NULL,
  domain text NOT NULL CHECK (domain IN ('coremail-professional','presales-general')),
  reviewer_id text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(revision_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS regression_cases (
  case_id text PRIMARY KEY,
  domain text NOT NULL CHECK (domain IN ('coremail-professional','presales-general')),
  question text NOT NULL,
  expected_card_id text,
  required_obligation_ids jsonb NOT NULL,
  forbidden_claims jsonb NOT NULL,
  kind text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS regression_runs (
  run_id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('queued','running','passed','failed')),
  total_cases integer NOT NULL DEFAULT 0,
  passed_cases integer NOT NULL DEFAULT 0,
  report jsonb,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS releases (
  release_id text PRIMARY KEY,
  professional_revision char(40) NOT NULL,
  general_revision char(40) NOT NULL,
  answer_contract_revision char(40) NOT NULL,
  card_catalog_hash char(64) NOT NULL,
  regression_run_id uuid NOT NULL REFERENCES regression_runs(run_id),
  manifest jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','active','superseded','failed','rolled_back')),
  created_by text NOT NULL,
  approved_by jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  activated_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_release_idx ON releases(status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS audit_events (
  audit_id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_resource_idx ON audit_events(resource_type, resource_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ops_jobs (
  job_id uuid PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,
  locked_by text,
  locked_at timestamptz,
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_jobs_claim_idx ON ops_jobs(status, available_at, created_at);

COMMIT;
