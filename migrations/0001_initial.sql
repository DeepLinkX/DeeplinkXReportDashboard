PRAGMA foreign_keys = ON;

CREATE TABLE catalogs (
  catalog_version TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 3),
  catalog_revision TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  source_url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  pulse_count INTEGER NOT NULL,
  full_count INTEGER NOT NULL,
  activated_at TEXT,
  created_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1))
);

CREATE UNIQUE INDEX catalogs_one_active ON catalogs(is_active) WHERE is_active = 1;

CREATE TABLE queries (
  catalog_version TEXT NOT NULL,
  query_id TEXT NOT NULL,
  query TEXT NOT NULL,
  lane TEXT NOT NULL,
  product_area TEXT NOT NULL,
  expression_type TEXT NOT NULL,
  profiles_json TEXT NOT NULL,
  product_fit TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  PRIMARY KEY (catalog_version, query_id),
  FOREIGN KEY (catalog_version) REFERENCES catalogs(catalog_version)
);

CREATE INDEX queries_catalog_lane ON queries(catalog_version, lane, product_area);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL CHECK (profile IN ('pulse', 'full', 'legacy-mixed')),
  catalog_version TEXT NOT NULL,
  report_date TEXT NOT NULL,
  requested_depth INTEGER NOT NULL,
  effective_depth INTEGER,
  trigger_source TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('creating', 'queued', 'running', 'finalizing', 'complete', 'incomplete', 'skipped')),
  query_count INTEGER NOT NULL,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_summary TEXT,
  report_materialized INTEGER NOT NULL DEFAULT 0 CHECK (report_materialized IN (0, 1)),
  FOREIGN KEY (catalog_version) REFERENCES catalogs(catalog_version)
);

CREATE INDEX runs_profile_date ON runs(profile, report_date DESC, created_at DESC);
CREATE INDEX runs_status ON runs(status, profile);

CREATE TABLE run_queries (
  run_id TEXT NOT NULL,
  query_id TEXT NOT NULL,
  query TEXT NOT NULL,
  lane TEXT NOT NULL,
  product_area TEXT NOT NULL,
  expression_type TEXT NOT NULL,
  product_fit TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  requested_depth INTEGER NOT NULL,
  actual_depth INTEGER NOT NULL DEFAULT 0,
  rank INTEGER,
  pages_scanned INTEGER NOT NULL DEFAULT 0,
  next_page INTEGER NOT NULL DEFAULT 1,
  exhausted INTEGER NOT NULL DEFAULT 0 CHECK (exhausted IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('planned', 'queued', 'running', 'complete', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  packages_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, query_id),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX run_queries_explorer ON run_queries(run_id, lane, product_area, rank);
CREATE INDEX run_queries_query_history ON run_queries(query_id, completed_at DESC);

CREATE TABLE search_positions (
  run_id TEXT NOT NULL,
  query_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  position INTEGER NOT NULL,
  page INTEGER NOT NULL,
  PRIMARY KEY (run_id, query_id, package_name),
  FOREIGN KEY (run_id, query_id) REFERENCES run_queries(run_id, query_id)
);

CREATE INDEX search_positions_competitor ON search_positions(run_id, package_name, position);

CREATE TABLE package_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  published_version TEXT,
  published_at TEXT,
  published_description TEXT,
  published_topics_json TEXT NOT NULL DEFAULT '[]',
  repository_version TEXT,
  repository_description TEXT,
  points INTEGER,
  max_points INTEGER,
  likes INTEGER,
  downloads_30d INTEGER,
  package_url TEXT NOT NULL,
  score_url TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  UNIQUE (run_id, package_name),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX package_snapshots_history ON package_snapshots(package_name, captured_at DESC);

CREATE TABLE competitors (
  run_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL,
  best_rank INTEGER NOT NULL,
  median_rank REAL NOT NULL,
  category TEXT NOT NULL,
  PRIMARY KEY (run_id, package_name),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE recommendations (
  run_id TEXT NOT NULL,
  query_id TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('protect', 'metadata gap', 'authority gap', 'capability gap', 'noise')),
  priority INTEGER NOT NULL,
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (run_id, query_id),
  FOREIGN KEY (run_id, query_id) REFERENCES run_queries(run_id, query_id)
);

CREATE INDEX recommendations_priority ON recommendations(run_id, priority, class);

CREATE TABLE report_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('markdown', 'csv', 'json', 'comparison-markdown', 'comparison-csv', 'comparison-json')),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, artifact_type),
  UNIQUE (filename),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX report_artifacts_run ON report_artifacts(run_id, artifact_type);

CREATE TABLE legacy_documents (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL,
  filename TEXT NOT NULL UNIQUE,
  report_date TEXT,
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE migration_records (
  id TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL UNIQUE,
  source_path TEXT NOT NULL,
  imported_run_id TEXT,
  row_count INTEGER NOT NULL,
  unmatched_count INTEGER NOT NULL,
  verification_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE raw_http_bodies (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  query_id TEXT,
  purpose TEXT NOT NULL,
  source_url TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  headers_json TEXT NOT NULL,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX raw_http_bodies_expiry ON raw_http_bodies(expires_at);

CREATE TABLE diagnostic_events (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  query_id TEXT,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX diagnostic_events_expiry ON diagnostic_events(expires_at);

CREATE TABLE system_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO system_state (key, value_json, updated_at)
VALUES ('retention', '{"retain_raw":true,"pause_full":false,"capacity_ratio":0}', datetime('now'));

PRAGMA optimize;
