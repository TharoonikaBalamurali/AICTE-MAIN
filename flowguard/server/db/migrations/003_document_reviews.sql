-- Per-document examination records made by scrutiny / re-scrutiny officials.
-- An examination record is the official's note on one uploaded file; it is not a statutory outcome.
-- Append-only: a later review supersedes an earlier one by being newer.
CREATE TABLE IF NOT EXISTS document_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  requirement_id text NOT NULL,
  submission_version int NOT NULL,
  status text NOT NULL CHECK (status IN ('EXAMINED_NO_OBSERVATION','OBSERVATION_RECORDED','CLARIFICATION_NEEDED')),
  observation text,
  source_reference text,
  reviewed_by uuid NOT NULL REFERENCES users(id),
  reviewer_role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_reviews_app_idx ON document_reviews(application_id, created_at DESC);
DROP TRIGGER IF EXISTS document_reviews_no_update ON document_reviews;
CREATE TRIGGER document_reviews_no_update BEFORE UPDATE OR DELETE ON document_reviews FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
