-- Committee proceedings (EC, SHC, SAC, Council), institution submissions to a committee, and decision provenance.
-- Recommendations (SHC, SAC) and decisions (EC, Council) stay separate records; all are append-only.

ALTER TABLE committee_reviews DROP CONSTRAINT IF EXISTS committee_reviews_committee_check;
ALTER TABLE committee_reviews ADD CONSTRAINT committee_reviews_committee_check CHECK (committee IN ('SHC','SAC'));

-- Who recorded a decision in which capacity, and the APH clause it was recorded under.
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS recorded_role text;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS aph_reference text;

-- Notes, clarification requests, hearing notices and hearing records. Only CLARIFICATION_REQUEST and
-- HEARING_NOTICE are disclosed to the institution; review notes and hearing records stay internal.
CREATE TABLE IF NOT EXISTS committee_proceedings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  committee text NOT NULL CHECK (committee IN ('EC','SHC','SAC','COUNCIL')),
  kind text NOT NULL CHECK (kind IN ('REVIEW_NOTE','CLARIFICATION_REQUEST','HEARING_NOTICE','HEARING_RECORD')),
  body text NOT NULL,
  hearing_at timestamptz,
  hearing_mode text CHECK (hearing_mode IN ('ONLINE','PHYSICAL')),
  hearing_venue text,
  disclosed boolean NOT NULL,
  application_status text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS committee_proceedings_app_idx ON committee_proceedings(application_id, created_at);

-- Compliance / supporting material an institution places before a committee (Ch. II §2.23.3; Ch. I §1.11(c), §2.24(c)).
CREATE TABLE IF NOT EXISTS committee_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  committee text NOT NULL CHECK (committee IN ('EC','SHC','SAC')),
  responds_to uuid REFERENCES committee_proceedings(id),
  note text NOT NULL,
  file_name text,
  mime_type text,
  size_bytes int,
  sha256 text,
  storage_key text,
  submitted_by uuid NOT NULL REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS committee_submissions_app_idx ON committee_submissions(application_id, submitted_at);

DROP TRIGGER IF EXISTS committee_proceedings_no_update ON committee_proceedings;
CREATE TRIGGER committee_proceedings_no_update BEFORE UPDATE OR DELETE ON committee_proceedings FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
DROP TRIGGER IF EXISTS committee_submissions_no_update ON committee_submissions;
CREATE TRIGGER committee_submissions_no_update BEFORE UPDATE OR DELETE ON committee_submissions FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
DROP TRIGGER IF EXISTS committee_reviews_no_update ON committee_reviews;
CREATE TRIGGER committee_reviews_no_update BEFORE UPDATE OR DELETE ON committee_reviews FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
DROP TRIGGER IF EXISTS decisions_no_update ON decisions;
CREATE TRIGGER decisions_no_update BEFORE UPDATE OR DELETE ON decisions FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
