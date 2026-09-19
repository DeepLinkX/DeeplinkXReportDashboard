PRAGMA foreign_keys = ON;

CREATE TABLE competitor_classifications (
  run_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'queued', 'running', 'complete', 'failed')),
  relationship TEXT NOT NULL DEFAULT 'unknown' CHECK (relationship IN ('direct', 'adjacent', 'noise', 'unknown')),
  capability_category TEXT NOT NULL DEFAULT 'other',
  classifier_version TEXT NOT NULL,
  published_version TEXT,
  published_description TEXT,
  published_topics_json TEXT NOT NULL DEFAULT '[]',
  package_url TEXT NOT NULL,
  metadata_captured_at TEXT,
  rationale TEXT NOT NULL DEFAULT 'Metadata classification has not completed.',
  matched_terms_json TEXT NOT NULL DEFAULT '[]',
  relevant_occurrence_count INTEGER NOT NULL DEFAULT 0,
  relevant_best_rank INTEGER,
  relevant_median_rank REAL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, package_name),
  FOREIGN KEY (run_id, package_name) REFERENCES competitors(run_id, package_name) ON DELETE CASCADE
);

CREATE INDEX competitor_classifications_filter
  ON competitor_classifications(run_id, relationship, relevant_occurrence_count DESC);

CREATE INDEX competitor_classifications_status
  ON competitor_classifications(run_id, status);

CREATE TABLE competitor_backfills (
  idempotency_key TEXT PRIMARY KEY,
  requested_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete')),
  response_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
