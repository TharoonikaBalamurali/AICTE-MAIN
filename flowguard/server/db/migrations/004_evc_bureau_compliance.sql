-- EVC registry and committee assignment, EVC member workspace, Regulation Bureau escalations,
-- central deadline register, operational policy configuration, compliance lifecycle and regions.
--
-- Regulatory notes (see README "Requirements that remain unverified"):
--  * EVC composition: APH Annexure 16 §16.5 and the Note under §16.6.
--  * APH Ch. I §1.9(a) describes member selection through AICTE's automated web portal; Definition 29 says the
--    Regional Officer constitutes the EVC. The manual Regional Officer selection implemented here is a
--    FlowGuard OPERATIONAL configuration, not the APH-prescribed selection method.
--  * Regions, follow-up thresholds and report due periods are not set by the APH: they are operational configuration.

-- ------------------------------------------------------------------ regions (operational configuration)
CREATE TABLE IF NOT EXISTS regions (
  code text PRIMARY KEY,
  name text NOT NULL,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE institutions ADD COLUMN IF NOT EXISTS region_code text REFERENCES regions(code);
CREATE TABLE IF NOT EXISTS user_regions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  region_code text NOT NULL REFERENCES regions(code),
  PRIMARY KEY (user_id, region_code)
);

-- ------------------------------------------------------------------ operational policies
CREATE TABLE IF NOT EXISTS operational_policies (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'DEMO_UNAUTHORISED' CHECK (status IN ('DEMO_UNAUTHORISED','AUTHORISED')),
  authorised_by text,
  authorised_at timestamptz,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operational_policy_history (
  id bigserial PRIMARY KEY,
  key text NOT NULL REFERENCES operational_policies(key),
  version int NOT NULL,
  value jsonb NOT NULL,
  status text NOT NULL,
  changed_by uuid REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS operational_policy_history_no_update ON operational_policy_history;
CREATE TRIGGER operational_policy_history_no_update BEFORE UPDATE OR DELETE ON operational_policy_history FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ------------------------------------------------------------------ EVC expert registry
CREATE SEQUENCE IF NOT EXISTS evc_expert_seq;
CREATE TABLE IF NOT EXISTS evc_experts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_code text NOT NULL UNIQUE,
  user_id uuid UNIQUE REFERENCES users(id),
  full_name text NOT NULL,
  official_email text NOT NULL,
  phone text,
  designation_level text NOT NULL CHECK (designation_level IN ('VICE_CHANCELLOR','DIRECTOR_IIT_NIT','PROFESSOR','ASSOCIATE_PROFESSOR','ASSISTANT_PROFESSOR','INDUSTRY_EXPERT','ARCHITECT','GOVT_TECHNICAL_OFFICER','OTHER')),
  discipline text NOT NULL CHECK (discipline IN ('ENGINEERING_TECHNOLOGY','MANAGEMENT','PHARMACY','ARCHITECTURE','PLANNING','CIVIL_STRUCTURAL','COMPUTER_APPLICATIONS','HOTEL_MANAGEMENT','APPLIED_ARTS','OTHER')),
  specialisation text,
  organisation text NOT NULL,
  organisation_type text NOT NULL CHECK (organisation_type IN ('IIT','IIM','NIT','GOVERNMENT','GOVERNMENT_AIDED','UNIVERSITY','PRIVATE','INDUSTRY','CPWD','NBCC','DRDO','CSIR','OTHER')),
  experience_years numeric,
  coa_registration_no text,
  panel_status text NOT NULL DEFAULT 'NEEDS_VERIFICATION' CHECK (panel_status IN ('ON_APPROVED_PANEL','NOT_ON_PANEL','NEEDS_VERIFICATION')),
  panel_reference text,
  verification_status text NOT NULL DEFAULT 'NEEDS_VERIFICATION' CHECK (verification_status IN ('NEEDS_VERIFICATION','VERIFIED','REJECTED')),
  verification_source text,
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  region_code text REFERENCES regions(code),
  active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evc_expert_events (
  id bigserial PRIMARY KEY,
  expert_id uuid NOT NULL REFERENCES evc_experts(id),
  event text NOT NULL,
  actor_id uuid REFERENCES users(id),
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS evc_expert_events_no_update ON evc_expert_events;
CREATE TRIGGER evc_expert_events_no_update BEFORE UPDATE OR DELETE ON evc_expert_events FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ------------------------------------------------------------------ committee assignment & visits
ALTER TABLE evc_visit_members ADD COLUMN IF NOT EXISTS expert_id uuid REFERENCES evc_experts(id);
ALTER TABLE evc_visit_members ADD COLUMN IF NOT EXISTS seat text CHECK (seat IN ('ACADEMICIAN','EXPERT','ARCHITECT_PLANNING','CO_OPTED','CHAIRMAN_DEEMED_UNIVERSITY'));
ALTER TABLE evc_visit_members ADD COLUMN IF NOT EXISTS ack_status text NOT NULL DEFAULT 'PENDING' CHECK (ack_status IN ('PENDING','ACKNOWLEDGED','CONFLICT_REPORTED'));
ALTER TABLE evc_visit_members ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE evc_visit_members ADD COLUMN IF NOT EXISTS conflict_note text;
ALTER TABLE evc_visit_members ADD COLUMN IF NOT EXISTS attendance text NOT NULL DEFAULT 'NOT_RECORDED' CHECK (attendance IN ('NOT_RECORDED','PRESENT','ABSENT'));
ALTER TABLE evc_visit_members ADD COLUMN IF NOT EXISTS attendance_recorded_by uuid REFERENCES users(id);
ALTER TABLE evc_visit_members ADD COLUMN IF NOT EXISTS attendance_recorded_at timestamptz;
ALTER TABLE evc_visit_members ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE evc_visit_members ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE evc_visit_members ADD COLUMN IF NOT EXISTS removed_reason text;

ALTER TABLE evc_visits DROP CONSTRAINT IF EXISTS evc_visits_status_check;
ALTER TABLE evc_visits ADD CONSTRAINT evc_visits_status_check CHECK (status IN ('PROPOSED','SCHEDULED','RESCHEDULED','IN_PROGRESS','COMPLETED','MISSED','CANCELLED'));
ALTER TABLE evc_visits ADD COLUMN IF NOT EXISTS offline_justification text;
ALTER TABLE evc_visits ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE evc_visits ADD COLUMN IF NOT EXISTS completed_by uuid REFERENCES users(id);
ALTER TABLE evc_visits ADD COLUMN IF NOT EXISTS missed_reason text;
ALTER TABLE evc_visits ADD COLUMN IF NOT EXISTS institution_video_link text;
ALTER TABLE evc_visits ADD COLUMN IF NOT EXISTS composition jsonb;

-- Report drafts (mutable working copy per author) and evidence; submitted reports stay versioned in evc_reports.
CREATE TABLE IF NOT EXISTS evc_report_drafts (
  visit_id uuid NOT NULL REFERENCES evc_visits(id),
  author_id uuid NOT NULL REFERENCES users(id),
  sections jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommendation text,
  disclosed_summary text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (visit_id, author_id)
);
CREATE TABLE IF NOT EXISTS evc_report_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id uuid NOT NULL REFERENCES evc_visits(id),
  application_id uuid NOT NULL REFERENCES applications(id),
  report_id uuid REFERENCES evc_reports(id),
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes int NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  note text,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE evc_reports ADD COLUMN IF NOT EXISTS sections jsonb;
ALTER TABLE evc_reports ADD COLUMN IF NOT EXISTS receipt_no text;

-- ------------------------------------------------------------------ central deadlines (EVC acknowledgement / report)
CREATE TABLE IF NOT EXISTS deadlines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('EVC_ACKNOWLEDGEMENT','EVC_REPORT','EVC_VISIT_OUTCOME')),
  subject_id text NOT NULL,
  application_id uuid REFERENCES applications(id),
  visit_id uuid REFERENCES evc_visits(id),
  responsible_role text NOT NULL,
  responsible_user_id uuid REFERENCES users(id),
  due_at timestamptz NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('APH_RULE','AUTHORISED_OPERATIONAL_CONFIGURATION')),
  source_reference text NOT NULL,
  policy_key text,
  policy_version int,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','MET','OVERDUE','ESCALATED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS deadlines_open_idx ON deadlines(status, due_at);

-- ------------------------------------------------------------------ Regulation Bureau escalations
CREATE SEQUENCE IF NOT EXISTS escalation_ref_seq;
CREATE TABLE IF NOT EXISTS escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_no text NOT NULL UNIQUE,
  application_id uuid NOT NULL REFERENCES applications(id),
  visit_id uuid REFERENCES evc_visits(id),
  kind text NOT NULL CHECK (kind IN ('VISIT_MISSED','VISIT_OUTCOME_UNRESOLVED','REPORT_OVERDUE','ACKNOWLEDGEMENT_OVERDUE','SCHEDULING_DISPUTE','OTHER')),
  reason text NOT NULL,
  deadline_at timestamptz,
  deadline_source text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','EXPLANATION_REQUESTED','ACTION_ASSIGNED','RETURNED_FOR_INFORMATION','RESOLVED','CLOSED')),
  owner_id uuid REFERENCES users(id),
  dedupe_key text NOT NULL UNIQUE,
  raised_by uuid REFERENCES users(id),
  raised_role text NOT NULL,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS escalations_status_idx ON escalations(status, created_at DESC);
CREATE TABLE IF NOT EXISTS escalation_actions (
  id bigserial PRIMARY KEY,
  escalation_id uuid NOT NULL REFERENCES escalations(id),
  action text NOT NULL,
  note text,
  actor_id uuid REFERENCES users(id),
  actor_role text NOT NULL,
  assigned_to uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS escalation_actions_no_update ON escalation_actions;
CREATE TRIGGER escalation_actions_no_update BEFORE UPDATE OR DELETE ON escalation_actions FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ------------------------------------------------------------------ compliance lifecycle
ALTER TABLE compliance_obligations ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'COMPLIANCE' CHECK (kind IN ('COMPLIANCE','UNDERTAKING'));
ALTER TABLE compliance_obligations DROP CONSTRAINT IF EXISTS compliance_obligations_status_check;
UPDATE compliance_obligations SET status = 'SUBMITTED' WHERE status = 'SUBMITTED_FOR_REVIEW';
UPDATE compliance_obligations SET status = 'ACCEPTED_BY_AUTHORISED_REVIEWER' WHERE status = 'COMPLETED';
ALTER TABLE compliance_obligations ADD CONSTRAINT compliance_obligations_status_check
  CHECK (status IN ('OPEN','SUBMITTED','UNDER_REVIEW','ACCEPTED_BY_AUTHORISED_REVIEWER','DEFICIENT','HUMAN_REVIEW_REQUIRED'));
CREATE TABLE IF NOT EXISTS compliance_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id uuid NOT NULL REFERENCES compliance_obligations(id),
  version int NOT NULL,
  storage_key text NOT NULL,
  file_name text NOT NULL,
  sha256 text NOT NULL,
  note text,
  submitted_by uuid NOT NULL REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (obligation_id, version)
);
CREATE TABLE IF NOT EXISTS compliance_reviews (
  id bigserial PRIMARY KEY,
  obligation_id uuid NOT NULL REFERENCES compliance_obligations(id),
  submission_id uuid REFERENCES compliance_submissions(id),
  outcome text NOT NULL CHECK (outcome IN ('UNDER_REVIEW','ACCEPTED_BY_AUTHORISED_REVIEWER','DEFICIENT','HUMAN_REVIEW_REQUIRED')),
  note text NOT NULL,
  reviewer_id uuid NOT NULL REFERENCES users(id),
  reviewer_role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS compliance_submissions_no_update ON compliance_submissions;
CREATE TRIGGER compliance_submissions_no_update BEFORE UPDATE OR DELETE ON compliance_submissions FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
DROP TRIGGER IF EXISTS compliance_reviews_no_update ON compliance_reviews;
CREATE TRIGGER compliance_reviews_no_update BEFORE UPDATE OR DELETE ON compliance_reviews FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ------------------------------------------------------------------ rule publication (four-eyes)
ALTER TABLE regulatory_rules ADD COLUMN IF NOT EXISTS verified_by text;

-- ------------------------------------------------------------------ unified deadline register (read model; no duplicate source of truth)
CREATE OR REPLACE VIEW deadline_register AS
  SELECT 'DEFICIENCY_CORRECTION'::text AS subject_type, d.id::text AS subject_id, d.application_id, a.institution_id,
         'INSTITUTION_APPLICANT'::text AS responsible_role, NULL::uuid AS responsible_user_id,
         (d.deadline::timestamp + interval '23 hours 59 minutes') AT TIME ZONE 'Asia/Kolkata' AS due_at,
         CASE WHEN d.deadline_type = 'APH' THEN 'APH_RULE' ELSE 'AUTHORISED_OPERATIONAL_CONFIGURATION' END AS source_type,
         coalesce(d.deadline_basis, '') AS source_reference,
         CASE WHEN d.status IN ('OPEN','UNRESOLVED','PARTIALLY_RESOLVED') THEN 'OPEN' ELSE 'MET' END AS status,
         d.reference_no AS label
  FROM deficiencies d JOIN applications a ON a.id = d.application_id
  WHERE d.deadline IS NOT NULL AND d.status NOT IN ('DRAFT','WITHDRAWN')
  UNION ALL
  SELECT CASE WHEN o.kind = 'UNDERTAKING' THEN 'UNDERTAKING' ELSE 'COMPLIANCE' END, o.id::text, o.application_id, o.institution_id,
         'INSTITUTION_APPLICANT', NULL::uuid,
         (o.due_date::timestamp + interval '23 hours 59 minutes') AT TIME ZONE 'Asia/Kolkata',
         'APH_RULE', o.aph_reference,
         CASE WHEN o.status = 'ACCEPTED_BY_AUTHORISED_REVIEWER' THEN 'MET' ELSE 'OPEN' END,
         o.title
  FROM compliance_obligations o WHERE o.due_date IS NOT NULL
  UNION ALL
  SELECT x.subject_type, x.subject_id, x.application_id, a.institution_id, x.responsible_role, x.responsible_user_id, x.due_at,
         x.source_type, x.source_reference, x.status, x.subject_type
  FROM deadlines x LEFT JOIN applications a ON a.id = x.application_id;
