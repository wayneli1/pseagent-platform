BEGIN;

ALTER TABLE feedback_cases
  DROP CONSTRAINT IF EXISTS feedback_cases_classification_check;

ALTER TABLE feedback_cases
  ADD CONSTRAINT feedback_cases_classification_check
  CHECK (classification IN ('useful','incorrect','missing','review_requested','evidence','correction'));

COMMIT;
