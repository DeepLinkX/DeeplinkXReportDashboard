ALTER TABLE report_artifacts ADD COLUMN content_storage TEXT NOT NULL DEFAULT 'inline'
  CHECK(content_storage IN ('inline','chunked'));

CREATE TABLE report_artifact_chunks (
  artifact_id TEXT NOT NULL REFERENCES report_artifacts(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
  content TEXT NOT NULL,
  PRIMARY KEY(artifact_id, chunk_index)
);
