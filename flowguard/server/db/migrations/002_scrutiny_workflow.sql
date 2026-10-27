-- Scrutiny, re-scrutiny, deficiency notices, deadline monitoring and EVC handoff/scheduling.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS submission_version int NOT NULL DEFAULT 0;

ALTER TABLE validation_runs ADD COLUMN IF NOT EXISTS submission_version int;

ALTER TABLE validation_findings ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE validation_findings ADD COLUMN IF NOT EXISTS human_verification boolean NOT NULL DEFAULT false;
ALTER TABLE validation_findings DROP CONSTRAINT IF EXISTS validation_findings_outcome_check;
ALTER TABLE validation_findings ADD CONSTRAINT validation_findings_outcome_check CHECK (outcome IN ('PASS','FAIL','WARNING','HUMAN_REVIEW','NOT_APPLICABLE'));

-- Technical file checks recorded at upload (readability, embedded signature structure). Not proof of authenticity.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS integrity jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE deficiencies DROP CONSTRAINT IF EXISTS deficiencies_status_check;
ALTER TABLE deficiencies ADD CONSTRAINT deficiencies_status_check CHECK (status IN ('DRAFT','OPEN','RESPONDED','RESOLVED','UNRESOLVED','PARTIALLY_RESOLVED','WITHDRAWN'));
ALTER TABLE deficiencies ADD COLUMN IF NOT EXISTS notice_id uuid;
ALTER TABLE deficiencies ADD COLUMN IF NOT EXISTS parent_deficiency_id uuid REFERENCES deficiencies(id);
ALTER TABLE deficiencies ADD COLUMN IF NOT EXISTS deadline_type text NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK (deadline_type IN ('APH','OPERATIONAL','NOT_CONFIGURED'));
ALTER TABLE deficiencies ADD COLUMN IF NOT EXISTS required_replacement text;
ALTER TABLE deficiencies ADD COLUMN IF NOT EXISTS source_finding_rule_id text;
ALTER TABLE deficiencies ADD COLUMN IF NOT EXISTS automated_assessment text;
ALTER TABLE deficiencies ADD COLUMN IF NOT EXISTS officer_response text;

CREATE SEQUENCE IF NOT EXISTS notice_ref_seq START 1;
CREATE TABLE IF NOT EXISTS deficiency_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_no text NOT NULL,
  application_id uuid NOT NULL REFERENCES applications(id),
  version int NOT NULL,
  submission_version int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('INITIAL','FURTHER_CORRECTION')),
  content jsonb NOT NULL,
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  supersedes_id uuid REFERENCES deficiency_notices(id),
  issued_by uuid NOT NULL REFERENCES users(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, version),
  UNIQUE (notice_no, version)
);

CREATE TABLE IF NOT EXISTS correction_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  version int NOT NULL,
  submission_version int NOT NULL,
  notice_id uuid REFERENCES deficiency_notices(id),
  items jsonb NOT NULL,
  changed_fields text[] NOT NULL DEFAULT '{}',
  changed_docs text[] NOT NULL DEFAULT '{}',
  validation_run_id uuid REFERENCES validation_runs(id),
  submitted_by uuid NOT NULL REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, version)
);

CREATE TABLE IF NOT EXISTS workflow_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  kind text NOT NULL CHECK (kind IN ('SCRUTINY','RE_SCRUTINY')),
  version int NOT NULL,
  submission_version int NOT NULL,
  run_id uuid REFERENCES validation_runs(id),
  correction_submission_id uuid REFERENCES correction_submissions(id),
  content jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, kind, version)
);

CREATE TABLE IF NOT EXISTS officer_actions (
  id bigserial PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  actor_role text NOT NULL,
  action text NOT NULL,
  reason text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS officer_actions_app_idx ON officer_actions(application_id, id);
DROP TRIGGER IF EXISTS officer_actions_no_update ON officer_actions;
CREATE TRIGGER officer_actions_no_update BEFORE UPDATE OR DELETE ON officer_actions FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE IF NOT EXISTS assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  role text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  assigned_by uuid NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS assignments_one_active ON assignments(application_id, role) WHERE active;

CREATE TABLE IF NOT EXISTS verification_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_role text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolution text,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evc_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  eligibility jsonb NOT NULL,
  approved_by uuid NOT NULL REFERENCES users(id),
  approved_role text NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE evc_visits DROP CONSTRAINT IF EXISTS evc_visits_status_check;
ALTER TABLE evc_visits ADD CONSTRAINT evc_visits_status_check CHECK (status IN ('PROPOSED','SCHEDULED','RESCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED'));
ALTER TABLE evc_visits ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

CREATE TABLE IF NOT EXISTS evc_visit_members (
  visit_id uuid NOT NULL REFERENCES evc_visits(id),
  user_id uuid NOT NULL REFERENCES users(id),
  assigned_by uuid NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (visit_id, user_id)
);

CREATE TABLE IF NOT EXISTS evc_visit_events (
  id bigserial PRIMARY KEY,
  visit_id uuid NOT NULL REFERENCES evc_visits(id),
  event text NOT NULL,
  actor_id uuid REFERENCES users(id),
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Notification delivery tracking and de-duplication.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'DELIVERED' CHECK (delivery_status IN ('PENDING','DELIVERED','FAILED'));
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 1;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe ON notifications(recipient_user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS deadline_events (
  id bigserial PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  application_id uuid REFERENCES applications(id),
  event_type text NOT NULL CHECK (event_type IN ('REMINDER','OVERDUE','ESCALATED')),
  dedupe_key text NOT NULL UNIQUE,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_runs (
  id bigserial PRIMARY KEY,
  job text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  summary jsonb,
  error text
);
