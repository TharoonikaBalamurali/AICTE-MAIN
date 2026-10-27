-- EVC: the signed inspection report document is its own category, separate from visit evidence (photos, video).
ALTER TABLE evc_report_evidence DROP CONSTRAINT IF EXISTS evc_report_evidence_category_check;
ALTER TABLE evc_report_evidence ADD CONSTRAINT evc_report_evidence_category_check
  CHECK (category IN ('INSPECTION_REPORT','SUPPORTING_DOCUMENT','ATTENDANCE_SHEET','VISIT_PHOTO','VIDEO_RECORDING','OTHER'));
