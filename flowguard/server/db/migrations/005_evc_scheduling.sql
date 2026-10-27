-- EVC scheduling: time ranges, reservations with database-level overlap protection, independent member responses,
-- member unavailability and an append-only schedule history.
--
-- Rule A (no overlapping assignments per official) is enforced by an exclusion constraint on the half-open range
-- [start - buffer, end + buffer) held on each committee seat while it occupies the official's time. Concurrent
-- requests cannot both commit an overlapping range: the second insert/update fails with 23P01.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------------ visit time range
ALTER TABLE evc_visits ADD COLUMN IF NOT EXISTS scheduled_end timestamptz;
ALTER TABLE evc_visits ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE evc_visits ADD COLUMN IF NOT EXISTS schedule_version int NOT NULL DEFAULT 1;
ALTER TABLE evc_visits ADD COLUMN IF NOT EXISTS draft_panel jsonb;
ALTER TABLE evc_visits ADD COLUMN IF NOT EXISTS invitations_sent_at timestamptz;
ALTER TABLE evc_visits DROP CONSTRAINT IF EXISTS evc_visits_time_range_check;
ALTER TABLE evc_visits ADD CONSTRAINT evc_visits_time_range_check CHECK (scheduled_end IS NULL OR scheduled_end > scheduled_start);
ALTER TABLE evc_visits DROP CONSTRAINT IF EXISTS evc_visits_time_zone_check;
ALTER TABLE evc_visits ADD CONSTRAINT evc_visits_time_zone_check CHECK (time_zone IN ('Asia/Kolkata'));

-- ------------------------------------------------------------------ member responses (one row per official per visit)
ALTER TABLE evc_visit_members DROP CONSTRAINT IF EXISTS evc_visit_members_ack_status_check;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'evc_visit_members' AND column_name = 'ack_status') THEN
    ALTER TABLE evc_visit_members RENAME COLUMN ack_status TO response_status;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'evc_visit_members' AND column_name = 'acknowledged_at') THEN
    ALTER TABLE evc_visit_members RENAME COLUMN acknowledged_at TO responded_at;
  END IF;
END $$;
ALTER TABLE evc_visit_members ALTER COLUMN response_status SET DEFAULT 'INVITED';
UPDATE evc_visit_members SET response_status = 'INVITED' WHERE response_status = 'PENDING';
UPDATE evc_visit_members SET response_status = 'ACCEPTED' WHERE response_status = 'ACKNOWLEDGED';
ALTER TABLE evc_visit_members ADD CONSTRAINT evc_visit_members_response_status_check
  CHECK (response_status IN ('INVITED','ACCEPTED','REJECTED','CONFLICT_REPORTED','WITHDRAWAL_REQUESTED'));
ALTER TABLE evc_visit_members ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE evc_visit_members ADD COLUMN IF NOT EXISTS reserved_period tstzrange;
ALTER TABLE evc_visit_members ADD COLUMN IF NOT EXISTS invited_version int;
ALTER TABLE evc_visit_members DROP CONSTRAINT IF EXISTS evc_member_no_overlap;
ALTER TABLE evc_visit_members ADD CONSTRAINT evc_member_no_overlap
  EXCLUDE USING gist (user_id WITH =, reserved_period WITH &&) WHERE (reserved_period IS NOT NULL);
CREATE INDEX IF NOT EXISTS evc_visit_members_user_idx ON evc_visit_members(user_id) WHERE reserved_period IS NOT NULL;

-- ------------------------------------------------------------------ explicit unavailability (leave, other commitments)
CREATE TABLE IF NOT EXISTS evc_member_unavailability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expert_id uuid NOT NULL REFERENCES evc_experts(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS evc_member_unavailability_idx ON evc_member_unavailability(expert_id, starts_at);

-- ------------------------------------------------------------------ schedule history (append-only)
CREATE TABLE IF NOT EXISTS evc_schedule_history (
  id bigserial PRIMARY KEY,
  visit_id uuid NOT NULL REFERENCES evc_visits(id),
  previous_start timestamptz,
  previous_end timestamptz,
  new_start timestamptz,
  new_end timestamptz,
  previous_status text,
  new_status text,
  schedule_version int NOT NULL,
  actor_id uuid REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS evc_schedule_history_no_update ON evc_schedule_history;
CREATE TRIGGER evc_schedule_history_no_update BEFORE UPDATE OR DELETE ON evc_schedule_history FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ------------------------------------------------------------------ evidence review status
ALTER TABLE evc_report_evidence ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'NOT_REVIEWED' CHECK (review_status IN ('NOT_REVIEWED','REVIEWED'));
