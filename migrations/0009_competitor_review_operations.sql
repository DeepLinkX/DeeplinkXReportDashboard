-- Durable review coordination; existing intelligence kinds and immutable reports stay intact.
CREATE TABLE review_operations (
 id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, manifest_json TEXT NOT NULL DEFAULT '[]', product_commit TEXT NOT NULL,
 policy_version TEXT NOT NULL, scope TEXT NOT NULL, evidence_mode TEXT NOT NULL,
 apply_reviews INTEGER NOT NULL DEFAULT 0, stop_on_quota INTEGER NOT NULL DEFAULT 1, resource_dispatch TEXT NOT NULL DEFAULT 'idle', status TEXT NOT NULL DEFAULT 'running',
 counters_json TEXT NOT NULL DEFAULT '{}', inventory_json TEXT NOT NULL DEFAULT '{}',
 notes_json TEXT NOT NULL DEFAULT '{}', expected_packages INTEGER,
 retry_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE review_operation_packages (
 operation_id TEXT NOT NULL REFERENCES review_operations(id), package_name TEXT NOT NULL,
 disposition TEXT NOT NULL, relationship TEXT NOT NULL, evidence_hash TEXT,
 previous_json TEXT NOT NULL DEFAULT '{}', provenance_json TEXT NOT NULL DEFAULT '{}',
 lease_key TEXT, lease_until TEXT, result_json TEXT, import_status TEXT, metrics_outcome TEXT, bootstrap_complete INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
 PRIMARY KEY(operation_id,package_name)
);
CREATE INDEX review_operation_packages_lane ON review_operation_packages(operation_id,disposition,package_name);
CREATE TABLE review_operation_questions (
 operation_id TEXT NOT NULL, package_name TEXT NOT NULL, question_key TEXT NOT NULL,
 lane TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 frozen_hash TEXT, lease_key TEXT, lease_until TEXT, answer_json TEXT,
 PRIMARY KEY(operation_id,package_name,question_key),
 FOREIGN KEY(operation_id,package_name) REFERENCES review_operation_packages(operation_id,package_name)
);
CREATE INDEX review_operation_questions_pending ON review_operation_questions(operation_id,status,package_name);
CREATE TABLE review_operation_resources (
 operation_id TEXT NOT NULL, package_name TEXT NOT NULL, kind TEXT NOT NULL,
 version TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
 source_url TEXT, body TEXT, content_hash TEXT, observed_at TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT, error TEXT, missing_json TEXT, queued INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(operation_id,package_name,kind,version),
 FOREIGN KEY(operation_id,package_name) REFERENCES review_operation_packages(operation_id,package_name)
);
CREATE INDEX review_operation_resources_due ON review_operation_resources(operation_id,status,retry_at,package_name);
CREATE TABLE review_operation_receipts (
 operation_id TEXT NOT NULL, receipt_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 response_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY(operation_id,receipt_key)
);
CREATE TABLE review_operation_events (
 operation_id TEXT NOT NULL, event_key TEXT NOT NULL, PRIMARY KEY(operation_id,event_key)
);
CREATE TABLE review_operation_artifacts (
 operation_id TEXT NOT NULL, format TEXT NOT NULL, chunk_index INTEGER NOT NULL,
 content TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(operation_id,format,chunk_index)
);

CREATE INDEX competitor_registry_metrics_due ON competitor_registry(relationship,metrics_captured_at,package_name);

CREATE INDEX raw_http_bodies_source_capture ON raw_http_bodies(source_url,captured_at);
