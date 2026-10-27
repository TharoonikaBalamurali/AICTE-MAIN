-- Lease renewal tracking (APH Ch. VI §6.17(a); Ch. II §2.1(e)).
-- Reuses the existing compliance_obligations / compliance_submissions / compliance_reviews
-- lifecycle (reminder, submission, officer verification, escalation) — only a new `kind` is added.
ALTER TABLE compliance_obligations DROP CONSTRAINT IF EXISTS compliance_obligations_kind_check;
ALTER TABLE compliance_obligations ADD CONSTRAINT compliance_obligations_kind_check
  CHECK (kind IN ('COMPLIANCE', 'UNDERTAKING', 'LEASE_RENEWAL'));
