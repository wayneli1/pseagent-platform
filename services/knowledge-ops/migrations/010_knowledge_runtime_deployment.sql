ALTER TABLE repair_batches
  ADD COLUMN IF NOT EXISTS deployment_stage text,
  ADD COLUMN IF NOT EXISTS serving_previous_version boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS target_professional_revision text,
  ADD COLUMN IF NOT EXISTS target_general_revision text,
  ADD COLUMN IF NOT EXISTS quality_run_id uuid REFERENCES regression_runs(run_id);

UPDATE repair_batches
SET deployment_stage = CASE status
  WHEN 'published' THEN 'active'
  WHEN 'rolled_back' THEN 'rolled_back'
  WHEN 'failed' THEN 'failed'
  ELSE 'queued'
END
WHERE deployment_stage IS NULL;

UPDATE repair_batches
SET serving_previous_version = CASE
  WHEN status IN ('published', 'rolled_back') THEN false
  ELSE true
END;

ALTER TABLE repair_batches
  ALTER COLUMN deployment_stage SET NOT NULL,
  ALTER COLUMN deployment_stage SET DEFAULT 'queued';

ALTER TABLE repair_batches DROP CONSTRAINT IF EXISTS repair_batches_deployment_stage_check;
ALTER TABLE repair_batches ADD CONSTRAINT repair_batches_deployment_stage_check CHECK (
  deployment_stage IN (
    'queued', 'running_global_regression', 'writing_git', 'pushing_github',
    'reloading_engine', 'activating_snapshot', 'verifying_online', 'active',
    'compensating', 'failed', 'rolled_back'
  )
);
