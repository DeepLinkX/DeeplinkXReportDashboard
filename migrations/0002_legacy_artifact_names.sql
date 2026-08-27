UPDATE report_artifacts
SET filename = 'pubdev_keyword_visibility_report_' ||
  (SELECT report_date FROM runs WHERE runs.id = report_artifacts.run_id) ||
  CASE artifact_type
    WHEN 'markdown' THEN '.md'
    WHEN 'csv' THEN '.csv'
    WHEN 'json' THEN '.json'
  END
WHERE run_id LIKE 'legacy-visibility-%';

CREATE INDEX IF NOT EXISTS report_artifacts_filename ON report_artifacts(filename);
