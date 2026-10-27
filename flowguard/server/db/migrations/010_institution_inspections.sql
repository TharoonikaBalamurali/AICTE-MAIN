-- Standalone / random institutional inspection (APH Ch. II §2.3.5(a): "Institutions at random shall
-- be subject to EVC (Inspection) for the fulfilment of the norms of the Approval Process Handbook").
-- Deliberately separate from evc_visits: that table and its scheduling/report code are tied to an
-- application end to end, and an inspection is not — it targets an institution directly, with no
-- pending application. Reuses the same EVC committee-composition rules (server/evc/composition.ts)
-- and expert registry (evc_experts), but keeps its own tables so the existing, tested application-EVC
-- workflow is untouched.
CREATE SEQUENCE IF NOT EXISTS inspection_ref_seq;

CREATE TABLE IF NOT EXISTS institution_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_no text NOT NULL UNIQUE,
  institution_id uuid NOT NULL REFERENCES institutions(id),
  reason text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('ONLINE', 'PHYSICAL')),
  scheduled_start timestamptz,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'MISSED', 'CANCELLED')),
  outcome_note text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inspections_inst_idx ON institution_inspections(institution_id, status);

CREATE TABLE IF NOT EXISTS inspection_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES institution_inspections(id),
  expert_id uuid NOT NULL REFERENCES evc_experts(id),
  user_id uuid REFERENCES users(id),
  seat text NOT NULL,
  response_status text NOT NULL DEFAULT 'INVITED' CHECK (response_status IN ('INVITED', 'ACCEPTED', 'DECLINED')),
  active boolean NOT NULL DEFAULT true,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  UNIQUE (inspection_id, expert_id)
);

CREATE TABLE IF NOT EXISTS inspection_events (
  id bigserial PRIMARY KEY,
  inspection_id uuid NOT NULL REFERENCES institution_inspections(id),
  event text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS inspection_events_no_update ON inspection_events;
CREATE TRIGGER inspection_events_no_update BEFORE UPDATE OR DELETE ON inspection_events FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE IF NOT EXISTS inspection_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES institution_inspections(id),
  observations text NOT NULL,
  recommendation text NOT NULL,
  evidence_storage_key text,
  evidence_name text,
  submitted_by uuid NOT NULL REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS inspection_reports_no_update ON inspection_reports;
CREATE TRIGGER inspection_reports_no_update BEFORE UPDATE OR DELETE ON inspection_reports FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
