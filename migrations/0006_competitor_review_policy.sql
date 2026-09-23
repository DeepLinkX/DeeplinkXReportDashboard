CREATE TABLE competitor_review_policies (
  package_name TEXT PRIMARY KEY REFERENCES competitor_registry(package_name),
  state TEXT NOT NULL CHECK(state IN ('confirmed_noise','active','reopened')),
  scope TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  documentation_text TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  product_commit TEXT NOT NULL,
  reason TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  reopened_at TEXT,
  reopen_reason TEXT
);
CREATE INDEX competitor_review_policies_state ON competitor_review_policies(state,package_name);
ALTER TABLE competitor_registry ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE competitor_registry ADD COLUMN evidence_sources_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE intelligence_jobs ADD COLUMN outcome TEXT;
