ALTER TABLE issue_cases DROP CONSTRAINT IF EXISTS issue_cases_status_check;
ALTER TABLE issue_cases ADD CONSTRAINT issue_cases_status_check
  CHECK (status IN ('open','in_progress','awaiting_evidence','validating','resolved','dismissed'));

CREATE INDEX IF NOT EXISTS issue_cases_evidence_queue_idx
  ON issue_cases(status, last_seen_at DESC)
  WHERE status='awaiting_evidence';
