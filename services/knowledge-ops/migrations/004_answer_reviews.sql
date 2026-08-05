BEGIN;

CREATE TABLE IF NOT EXISTS answer_review_cases (
  review_id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  pseudonymous_user_id char(64) NOT NULL,
  processing_status text NOT NULL CHECK (processing_status IN ('queued','running','completed','errored')),
  verdict text NOT NULL CHECK (verdict IN ('pending','pass','needs_review','fail')),
  workflow_status text NOT NULL CHECK (workflow_status IN ('open','in_review','resolved','dismissed')),
  encrypted_payload jsonb NOT NULL,
  answer_status text NOT NULL,
  scope text,
  reference_count integer NOT NULL CHECK (reference_count >= 0),
  source text NOT NULL CHECK (source = 'lunkr_direct'),
  model text NOT NULL CHECK (model = 'deepseek_v4_flash'),
  score integer CHECK (score BETWEEN 0 AND 100),
  defect_count integer NOT NULL DEFAULT 0 CHECK (defect_count >= 0),
  error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS answer_review_cases_human_queue_idx
  ON answer_review_cases(workflow_status, verdict, updated_at DESC);
CREATE INDEX IF NOT EXISTS answer_review_cases_processing_idx
  ON answer_review_cases(processing_status, created_at);
CREATE INDEX IF NOT EXISTS answer_review_cases_user_idx
  ON answer_review_cases(pseudonymous_user_id, created_at DESC);

COMMIT;
