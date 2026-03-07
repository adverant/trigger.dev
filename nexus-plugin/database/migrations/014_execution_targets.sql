-- Migration: Add execution target configuration to task definitions
-- Allows tasks to be reassigned to different execution engines (skill, n8n workflow, webhook, etc.)

BEGIN;

ALTER TABLE trigger.task_definitions
  ADD COLUMN IF NOT EXISTS execution_type VARCHAR(50) DEFAULT 'prefix-derived',
  ADD COLUMN IF NOT EXISTS execution_target JSONB DEFAULT '{}';

-- Add check constraint separately for idempotency
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'task_definitions_execution_type_check'
  ) THEN
    ALTER TABLE trigger.task_definitions
      ADD CONSTRAINT task_definitions_execution_type_check
      CHECK (execution_type IN (
        'prefix-derived',
        'skill',
        'n8n-workflow',
        'code-handler',
        'mageagent-prompt',
        'external-webhook'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_task_definitions_execution_type
  ON trigger.task_definitions(execution_type)
  WHERE execution_type != 'prefix-derived';

COMMENT ON COLUMN trigger.task_definitions.execution_type IS 'How this task routes to its execution engine. Default prefix-derived uses taskIdentifier prefix.';
COMMENT ON COLUMN trigger.task_definitions.execution_target IS 'Target-specific config: skillId, workflowId, handler class, webhook URL, etc.';

COMMIT;
