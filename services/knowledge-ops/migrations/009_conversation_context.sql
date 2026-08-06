CREATE TABLE IF NOT EXISTS conversation_sessions (
  session_id uuid PRIMARY KEY,
  pseudonymous_user_id text NOT NULL CHECK (pseudonymous_user_id ~ '^[a-f0-9]{64}$'),
  source text NOT NULL CHECK (source = 'lunkr_direct'),
  started_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IS NULL OR end_reason IN ('manual','idle'))
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_sessions_one_active_user
  ON conversation_sessions(pseudonymous_user_id)
  WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS conversation_sessions_active_lookup
  ON conversation_sessions(pseudonymous_user_id, expires_at DESC)
  WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS conversation_turns (
  turn_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES conversation_sessions(session_id) ON DELETE CASCADE,
  turn_index integer NOT NULL CHECK (turn_index > 0),
  request_id uuid NOT NULL UNIQUE,
  question_id integer NOT NULL CHECK (question_id > 0),
  parent_turn_id uuid REFERENCES conversation_turns(turn_id),
  parent_request_id uuid,
  raw_question text NOT NULL CHECK (length(btrim(raw_question)) > 0),
  resolved_question text NOT NULL CHECK (length(btrim(resolved_question)) > 0),
  context_used boolean NOT NULL,
  inherited_subjects jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer_outline text,
  answer_status text NOT NULL,
  scope text,
  answer_card_match jsonb,
  answered_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, turn_index),
  CHECK ((context_used AND parent_turn_id IS NOT NULL AND parent_request_id IS NOT NULL) OR
         (NOT context_used AND parent_turn_id IS NULL AND parent_request_id IS NULL) OR
         (context_used AND parent_turn_id IS NULL AND parent_request_id IS NULL))
);

CREATE INDEX IF NOT EXISTS conversation_turns_session_order
  ON conversation_turns(session_id, turn_index DESC);
CREATE INDEX IF NOT EXISTS conversation_turns_parent_request
  ON conversation_turns(parent_request_id)
  WHERE parent_request_id IS NOT NULL;
