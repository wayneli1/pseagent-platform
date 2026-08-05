BEGIN;

UPDATE issue_cases SET status='in_progress',updated_at=now() WHERE status='assigned';

DROP INDEX IF EXISTS issue_cases_owner_idx;
ALTER TABLE issue_cases DROP CONSTRAINT IF EXISTS issue_cases_status_check;
ALTER TABLE issue_cases ADD CONSTRAINT issue_cases_status_check
  CHECK (status IN ('open','in_progress','validating','resolved','dismissed'));
ALTER TABLE issue_cases DROP COLUMN IF EXISTS owner_id;

COMMIT;
