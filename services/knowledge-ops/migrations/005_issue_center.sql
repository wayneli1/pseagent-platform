BEGIN;

CREATE TABLE IF NOT EXISTS issue_cases (
  issue_id uuid PRIMARY KEY,
  fingerprint char(64) NOT NULL UNIQUE,
  title text NOT NULL,
  priority text NOT NULL CHECK (priority IN ('p0','p1','p2','p3')),
  status text NOT NULL CHECK (status IN ('open','assigned','in_progress','validating','resolved','dismissed')),
  category text NOT NULL CHECK (category IN (
    'knowledge_gap','retrieval_gap','planning_gap','coverage_gap','logic_gap','citation_gap','expression_gap',
    'user_incorrect','user_missing','review_requested','evidence','correction','judgement_conflict','review_error'
  )),
  scope text,
  answer_card_key text,
  owner_id text,
  sla_due_at timestamptz NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS issue_cases_queue_idx ON issue_cases(status, priority, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS issue_cases_owner_idx ON issue_cases(owner_id, status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS issue_occurrences (
  occurrence_id uuid PRIMARY KEY,
  issue_id uuid NOT NULL REFERENCES issue_cases(issue_id),
  source_type text NOT NULL CHECK (source_type IN ('answer_review','feedback')),
  source_id uuid NOT NULL,
  request_id uuid NOT NULL,
  pseudonymous_user_id char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(source_type, source_id)
);
CREATE INDEX IF NOT EXISTS issue_occurrences_issue_idx ON issue_occurrences(issue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS issue_occurrences_request_idx ON issue_occurrences(request_id);

COMMIT;
