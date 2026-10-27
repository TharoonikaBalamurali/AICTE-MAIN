-- EVC member reporting: categorised evidence / supporting documents and the member's declaration on the final report.

ALTER TABLE evc_report_evidence ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'OTHER';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evc_report_evidence_category_check') THEN
    ALTER TABLE evc_report_evidence ADD CONSTRAINT evc_report_evidence_category_check
      CHECK (category IN ('VISIT_PHOTO','SUPPORTING_DOCUMENT','ATTENDANCE_SHEET','VIDEO_RECORDING','OTHER'));
  END IF;
END $$;

-- The submitting member confirms the report reflects what the committee verified (recorded, never assumed).
ALTER TABLE evc_reports ADD COLUMN IF NOT EXISTS declaration_at timestamptz;
