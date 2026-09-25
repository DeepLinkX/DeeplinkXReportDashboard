import { sha256Hex } from "../shared/catalog.js";

const INLINE_LIMIT_BYTES = 1_500_000;
const CHUNK_LIMIT_BYTES = 256_000;
const encoder = new TextEncoder();

export interface ReportArtifactInput {
  id: string;
  runId: string;
  type: "markdown" | "csv" | "json";
  filename: string;
  contentType: string;
  content: string;
  contentHash: string;
  createdAt: string;
}

function splitUtf8(value: string, maximumBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maximumBytes && current) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}

export async function storeReportArtifact(env: Env, input: ReportArtifactInput): Promise<void> {
  const byteLength = new TextEncoder().encode(input.content).byteLength;
  const chunked = byteLength > INLINE_LIMIT_BYTES;
  const chunks = chunked ? splitUtf8(input.content, CHUNK_LIMIT_BYTES) : [];
  const statements = [env.DB.prepare(`INSERT INTO report_artifacts
      (id, run_id, artifact_type, filename, content_type, content, content_hash, created_at, content_storage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, artifact_type) DO UPDATE SET
        filename=excluded.filename, content_type=excluded.content_type, content=excluded.content,
        content_hash=excluded.content_hash, content_storage=excluded.content_storage`)
    .bind(input.id, input.runId, input.type, input.filename, input.contentType,
      chunked ? "" : input.content, input.contentHash, input.createdAt, chunked ? "chunked" : "inline"),
  env.DB.prepare("DELETE FROM report_artifact_chunks WHERE artifact_id=?").bind(input.id)];
  chunks.forEach((content, chunkIndex) => statements.push(env.DB.prepare(
    "INSERT INTO report_artifact_chunks(artifact_id, chunk_index, content) VALUES(?,?,?)",
  ).bind(input.id, chunkIndex, content)));
  await env.DB.batch(statements);
}

export async function loadReportArtifactContent(env: Env, artifact: {
  id: string; content: string; content_hash: string; content_storage: "inline" | "chunked";
}): Promise<string> {
  if (artifact.content_storage !== "chunked") return artifact.content;
  const parts = await env.DB.prepare(
    "SELECT content FROM report_artifact_chunks WHERE artifact_id=? ORDER BY chunk_index",
  ).bind(artifact.id).all<{ content: string }>();
  const content = parts.results.map((part) => part.content).join("");
  if (await sha256Hex(content) !== artifact.content_hash) throw new Error("Stored report artifact chunks failed hash verification.");
  return content;
}
