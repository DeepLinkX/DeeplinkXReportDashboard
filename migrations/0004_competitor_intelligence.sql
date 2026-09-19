CREATE TABLE competitor_registry (
  package_name TEXT PRIMARY KEY,
  metadata_json TEXT,
  score_json TEXT,
  documentation_text TEXT,
  documentation_version TEXT,
  metadata_captured_at TEXT,
  metrics_captured_at TEXT,
  documentation_captured_at TEXT,
  metadata_error TEXT,
  metrics_error TEXT,
  documentation_error TEXT,
  analysis_json TEXT NOT NULL DEFAULT '{}',
  evidence_hash TEXT NOT NULL DEFAULT '',
  product_commit TEXT NOT NULL DEFAULT '',
  classifier_version TEXT NOT NULL DEFAULT '',
  relationship TEXT NOT NULL DEFAULT 'unknown',
  downloads_30d INTEGER,
  likes INTEGER,
  points INTEGER,
  max_points INTEGER,
  published_at TEXT,
  refresh_status TEXT NOT NULL DEFAULT 'planned',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX competitor_registry_sort ON competitor_registry(relationship, downloads_30d DESC, package_name);

CREATE TABLE competitor_metric_observations (
  package_name TEXT NOT NULL REFERENCES competitor_registry(package_name),
  captured_at TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  PRIMARY KEY(package_name, captured_at)
);

CREATE TABLE competitor_discoveries (
  package_name TEXT NOT NULL REFERENCES competitor_registry(package_name),
  source_key TEXT NOT NULL,
  run_id TEXT,
  query_id TEXT,
  query TEXT,
  position INTEGER,
  depth INTEGER,
  captured_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  PRIMARY KEY(package_name, source_key)
);
CREATE INDEX competitor_discoveries_run ON competitor_discoveries(run_id, package_name);

CREATE TABLE intelligence_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('package','search','dispatch')),
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  next_page INTEGER NOT NULL DEFAULT 1,
  result_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX intelligence_jobs_status ON intelligence_jobs(run_id,status);

CREATE TABLE competitor_reviews (
  package_name TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  product_commit TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  PRIMARY KEY(package_name,evidence_hash,product_commit)
);
