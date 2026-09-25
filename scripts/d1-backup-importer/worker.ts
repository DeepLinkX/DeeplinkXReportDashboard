import type { D1Database } from "@cloudflare/workers-types";

interface ImportEnv {
  DB: D1Database;
  IMPORT_TOKEN: string;
}

const TABLES = new Set([
  "catalogs", "competitor_backfills", "competitor_classifications", "competitor_discoveries",
  "competitor_metric_observations", "competitor_registry", "competitor_reviews", "competitors",
  "diagnostic_events", "intelligence_jobs", "legacy_documents", "migration_records",
  "package_snapshots", "queries", "raw_http_bodies", "recommendations", "report_artifacts",
  "report_artifact_chunks", "run_queries", "runs", "search_positions", "system_state",
]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface ChunkRequest { chunk_id: string; source_sha256: string; table: string; columns: string[]; rows: Json[][]; }

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalSecret(provided: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(provided);
  const right = encoder.encode(expected);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

function decode(value: Json): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && typeof value.$blob_base64 === "string") {
      const binary = atob(value.$blob_base64);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decode(child)]));
  }
  if (typeof value === "boolean") return Number(value);
  return value;
}

function validate(body: unknown): asserts body is ChunkRequest {
  if (!body || typeof body !== "object") throw new Error("Invalid chunk payload.");
  const input = body as Partial<ChunkRequest>;
  if (typeof input.chunk_id !== "string" || !/^[a-zA-Z0-9_.-]{1,120}$/.test(input.chunk_id)
      || typeof input.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.source_sha256)
      || typeof input.table !== "string" || !TABLES.has(input.table)
      || !Array.isArray(input.columns) || !input.columns.length || input.columns.length > 100
      || input.columns.some((column) => typeof column !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(column))
      || new Set(input.columns).size !== input.columns.length
      || !Array.isArray(input.rows) || !input.rows.length || input.rows.length > 49
      || input.rows.some((row) => !Array.isArray(row) || row.length !== input.columns!.length)) {
    throw new Error("Invalid chunk shape or size.");
  }
}

function quotaResetSeconds(): number {
  const now = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1));
  return Math.max(60, Math.ceil((reset.getTime() - now.getTime()) / 1000));
}

export default {
  async fetch(request: Request, env: ImportEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ status: "ok" });
    if (request.method !== "POST" || url.pathname !== "/chunks") return json({ error: "not_found" }, 404);
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || !equalSecret(authorization.slice(7), env.IMPORT_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }
    try {
      const body: unknown = await request.json();
      validate(body);
      const input = body as ChunkRequest;
      const payloadHash = await sha256(stable({ table: input.table, columns: input.columns, rows: input.rows }));
      if (payloadHash !== input.source_sha256) return json({ error: "payload_hash_mismatch" }, 400);
      const receipt = await env.DB.prepare("SELECT source_sha256,row_count FROM backup_import_receipts WHERE chunk_id=?")
        .bind(input.chunk_id).first<{ source_sha256: string; row_count: number }>();
      if (receipt) {
        if (receipt.source_sha256 !== input.source_sha256 || receipt.row_count !== input.rows.length) {
          return json({ error: "chunk_id_conflict" }, 409);
        }
        return json({ status: "already_imported", rows: receipt.row_count, chunk_id: input.chunk_id });
      }
      const table = `"${input.table}"`;
      const columns = input.columns.map((column) => `"${column}"`).join(",");
      const values = `(${input.columns.map(() => "?").join(",")})`;
      const statements = input.rows.map((row) => env.DB.prepare(
        `INSERT INTO ${table} (${columns}) VALUES ${values}`,
      ).bind(...row.map(decode)));
      statements.push(env.DB.prepare("INSERT INTO backup_import_receipts(chunk_id,source_sha256,row_count,imported_at) VALUES(?,?,?,?)")
        .bind(input.chunk_id, input.source_sha256, input.rows.length, new Date().toISOString()));
      const results = await env.DB.batch(statements);
      const usage = results.reduce<{ rows_read: number; rows_written: number }>((totals, result) => ({
        rows_read: totals.rows_read + Number(result.meta?.rows_read ?? 0),
        rows_written: totals.rows_written + Number(result.meta?.rows_written ?? 0),
      }), { rows_read: 0, rows_written: 0 });
      return json({ status: "imported", chunk_id: input.chunk_id, rows: input.rows.length, ...usage });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      if (/daily.*(?:row read|row write).*limit|free tier.*daily/i.test(message)) {
        return new Response(JSON.stringify({ error: "daily_quota_exhausted" }), {
          status: 429, headers: { "content-type": "application/json", "cache-control": "no-store",
            "retry-after": String(quotaResetSeconds()) },
        });
      }
      console.error(JSON.stringify({ event: "backup-import-chunk-failed", message }));
      return json({ error: "chunk_import_failed" }, 400);
    }
  },
};
