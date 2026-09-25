CREATE TABLE backup_import_receipts (
  chunk_id TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
  row_count INTEGER NOT NULL CHECK(row_count > 0),
  imported_at TEXT NOT NULL
);
