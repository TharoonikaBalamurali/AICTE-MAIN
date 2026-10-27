-- AICTE FlowGuard — initial schema (PostgreSQL 15+; runs on Supabase Postgres and on embedded PGlite)

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_id text NOT NULL UNIQUE,
  email text NOT NULL,
  full_name text NOT NULL,
  designation text,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED','LOCKED')),
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aicte_institution_id text NOT NULL UNIQUE,
  id_verification_status text NOT NULL DEFAULT 'UNVERIFIED' CHECK (id_verification_status IN ('UNVERIFIED','VERIFIED')),
  name text NOT NULL,
  address text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT '',
  district text NOT NULL DEFAULT '',
  pincode text NOT NULL DEFAULT '',
  official_email text NOT NULL DEFAULT '',
  applicant_name text NOT NULL DEFAULT '',
  applicant_designation text NOT NULL DEFAULT '',
  legal_entity_type text,
  legal_entity_name text,
  legal_entity_reg_no text,
  signatory_name text,
  signatory_designation text,
  is_demo boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS institution_memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  membership_role text NOT NULL DEFAULT 'PREPARER',
  PRIMARY KEY (user_id, institution_id)
);

CREATE TABLE IF NOT EXISTS regulatory_rules (
  rule_id text NOT NULL,
  rule_version int NOT NULL,
  application_type text NOT NULL,
  action_subtype text,
  rule_type text NOT NULL,
  condition jsonb NOT NULL,
  expected_result text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('BLOCKING','ADVISORY')),
  aph_reference text,
  source_evidence text NOT NULL,
  verification_status text NOT NULL CHECK (verification_status IN ('VERIFIED','NEEDS_VERIFICATION')),
  lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('DRAFT','NEEDS_VERIFICATION','VERIFIED','APPROVED_FOR_EXECUTION','RETIRED')),
  target_type text NOT NULL,
  target_id text,
  target_label text NOT NULL,
  explanation text NOT NULL,
  corrective_action text NOT NULL,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, rule_version)
);
CREATE INDEX IF NOT EXISTS rules_type_idx ON regulatory_rules(application_type, lifecycle_status);

CREATE SEQUENCE IF NOT EXISTS application_ref_seq START 1;
CREATE SEQUENCE IF NOT EXISTS deficiency_ref_seq START 1;
CREATE SEQUENCE IF NOT EXISTS appeal_ref_seq START 1;

CREATE TABLE IF NOT EXISTS applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_no text UNIQUE,
  institution_id uuid NOT NULL REFERENCES institutions(id),
  category_code text NOT NULL,
  subtype text,
  academic_year text,
  status text NOT NULL DEFAULT 'DRAFT',
  field_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  institution_snapshot jsonb,
  applicant_name text,
  applicant_designation text,
  created_by uuid NOT NULL REFERENCES users(id),
  submitted_by uuid REFERENCES users(id),
  submitted_at timestamptz,
  ruleset_version text,
  reopen_count int NOT NULL DEFAULT 0,
  reopen_requested_at timestamptz,
  reopen_request_reason text,
  row_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'DRAFT' OR (reference_no IS NOT NULL AND submitted_at IS NOT NULL)),
  CHECK (reopen_count <= 1)
);
CREATE INDEX IF NOT EXISTS applications_inst_idx ON applications(institution_id, status);
CREATE INDEX IF NOT EXISTS applications_status_idx ON applications(status);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  requirement_id text NOT NULL,
  version int NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes int NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_current boolean NOT NULL DEFAULT true,
  deficiency_id uuid,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  UNIQUE (application_id, requirement_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS documents_one_current ON documents(application_id, requirement_id) WHERE is_current;

CREATE TABLE IF NOT EXISTS validation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  ruleset_version text NOT NULL,
  input_hash text NOT NULL,
  evaluation_date date NOT NULL,
  stage text NOT NULL,
  rules_evaluated int NOT NULL,
  summary jsonb NOT NULL,
  scope text NOT NULL DEFAULT 'FULL',
  run_by text NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS validation_runs_app_idx ON validation_runs(application_id, run_at DESC);

CREATE TABLE IF NOT EXISTS validation_findings (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES validation_runs(id) ON DELETE CASCADE,
  rule_id text NOT NULL,
  rule_version int NOT NULL,
  rule_type text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('PASS','FAIL','WARNING','HUMAN_REVIEW')),
  blocking boolean NOT NULL,
  target_type text NOT NULL,
  target_id text,
  target_label text NOT NULL,
  aph_reference text,
  explanation text NOT NULL,
  corrective_action text NOT NULL,
  stage text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS findings_run_idx ON validation_findings(run_id);

CREATE TABLE IF NOT EXISTS workflow_events (
  id bigserial PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id),
  from_status text,
  to_status text NOT NULL,
  action text NOT NULL,
  actor_id uuid REFERENCES users(id),
  actor_role text NOT NULL,
  note text,
  aph_reference text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wf_events_app_idx ON workflow_events(application_id, id);

CREATE TABLE IF NOT EXISTS deficiencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_no text NOT NULL UNIQUE,
  application_id uuid NOT NULL REFERENCES applications(id),
  target_type text NOT NULL CHECK (target_type IN ('FIELD','DOCUMENT','APPLICATION')),
  target_id text,
  target_label text NOT NULL,
  category text NOT NULL,
  explanation text NOT NULL,
  source_reference text,
  stage_detected text NOT NULL,
  corrective_action text NOT NULL,
  deadline date,
  deadline_basis text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESPONDED','RESOLVED','UNRESOLVED')),
  raised_by uuid NOT NULL REFERENCES users(id),
  raised_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deficiencies_app_idx ON deficiencies(application_id, status);

CREATE TABLE IF NOT EXISTS deficiency_events (
  id bigserial PRIMARY KEY,
  deficiency_id uuid NOT NULL REFERENCES deficiencies(id),
  event text NOT NULL,
  actor_id uuid REFERENCES users(id),
  note text,
  document_id uuid REFERENCES documents(id),
  field_changes jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evc_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  mode text NOT NULL CHECK (mode IN ('ONLINE','PHYSICAL')),
  scheduled_start timestamptz NOT NULL,
  location text,
  meeting_link text,
  agenda text,
  prepare_items text,
  instructions text,
  committee_disclosure text,
  status text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','RESCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED')),
  status_note text,
  scheduled_by uuid NOT NULL REFERENCES users(id),
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evc_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id uuid NOT NULL REFERENCES evc_visits(id),
  application_id uuid NOT NULL REFERENCES applications(id),
  version int NOT NULL,
  observations text NOT NULL,
  recommendation text NOT NULL,
  disclosed_summary text,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_status text NOT NULL DEFAULT 'SUBMITTED',
  submitted_by uuid NOT NULL REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (visit_id, version)
);

CREATE TABLE IF NOT EXISTS committee_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  committee text NOT NULL CHECK (committee IN ('SHC','SAC')),
  outcome text NOT NULL,
  notes text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  decision_type text NOT NULL CHECK (decision_type IN ('LOA','EOA','LOD','LOR','CLOSURE_ORDER','OTHER')),
  decision_body text NOT NULL CHECK (decision_body IN ('EXECUTIVE_COMMITTEE','COUNCIL')),
  reference_no text NOT NULL,
  issuing_authority text NOT NULL,
  decision_date date NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  reasons text,
  conditions text,
  corrective_action text,
  next_steps text,
  document_storage_key text,
  document_name text,
  document_sha256 text,
  is_appeal_outcome boolean NOT NULL DEFAULT false,
  recorded_by uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS decisions_app_idx ON decisions(application_id);

CREATE TABLE IF NOT EXISTS appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_no text NOT NULL UNIQUE,
  application_id uuid NOT NULL UNIQUE REFERENCES applications(id),
  decision_id uuid NOT NULL REFERENCES decisions(id),
  grounds text NOT NULL,
  supporting_storage_key text,
  supporting_name text,
  deadline_at timestamptz NOT NULL,
  deadline_basis text NOT NULL,
  status text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','UNDER_REVIEW','RECOMMENDED','NOT_RECOMMENDED','REFERRED','DECIDED')),
  sac_outcome text,
  sac_notes text,
  submitted_by uuid NOT NULL REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS compliance_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  application_id uuid REFERENCES applications(id),
  decision_id uuid REFERENCES decisions(id),
  obligation_key text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  aph_reference text NOT NULL,
  trigger_event text NOT NULL,
  due_date date,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SUBMITTED_FOR_REVIEW','COMPLETED')),
  evidence_storage_key text,
  evidence_name text,
  evidence_note text,
  reminder_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, obligation_key)
);
CREATE INDEX IF NOT EXISTS compliance_inst_idx ON compliance_obligations(institution_id, status);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  institution_id uuid REFERENCES institutions(id),
  application_id uuid REFERENCES applications(id),
  event_type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  channel text NOT NULL DEFAULT 'IN_APP',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications(recipient_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid,
  actor_role text,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  institution_id uuid,
  details jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_log(entity_type, entity_id);

-- Audit history is append-only.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Workflow history is append-only as well.
DROP TRIGGER IF EXISTS workflow_events_no_update ON workflow_events;
CREATE TRIGGER workflow_events_no_update BEFORE UPDATE OR DELETE ON workflow_events FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
