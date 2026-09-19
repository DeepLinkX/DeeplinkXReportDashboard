interface RetentionState {
  retain_raw: boolean;
  pause_full: boolean;
  capacity_ratio: number;
  last_pruned_at?: string;
  warning?: string;
}

const DAY_MS = 86_400_000;

export function expiryIso(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

export async function retentionState(env: Env): Promise<RetentionState> {
  const row = await env.DB.prepare("SELECT value_json FROM system_state WHERE key = 'retention'").first<{ value_json: string }>();
  if (!row) return { retain_raw: true, pause_full: false, capacity_ratio: 0 };
  return JSON.parse(row.value_json) as RetentionState;
}

export async function storeRawBody(
  env: Env,
  input: {
    runId?: string;
    queryId?: string;
    purpose: string;
    sourceUrl: string;
    response: Response;
    body: string;
  },
): Promise<void> {
  const state = await retentionState(env);
  if (!state.retain_raw) return;
  const capturedAt = new Date().toISOString();
  const body = input.body.slice(0, 512_000);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const bodyHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const headers = Object.fromEntries([...input.response.headers.entries()].filter(([name]) =>
    ["content-type", "date", "etag", "last-modified", "retry-after"].includes(name.toLowerCase()),
  ));
  await env.DB.prepare(
    `INSERT INTO raw_http_bodies (
      id, run_id, query_id, purpose, source_url, status_code, headers_json,
      body, body_hash, captured_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    input.runId ?? null,
    input.queryId ?? null,
    input.purpose,
    input.sourceUrl,
    input.response.status,
    JSON.stringify(headers),
    body,
    bodyHash,
    capturedAt,
    expiryIso(Number(env.RAW_RETENTION_DAYS)),
  ).run();
}

export async function recordDiagnostic(
  env: Env,
  input: { runId?: string; queryId?: string; severity: string; code: string; detail: string },
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO diagnostic_events (
      id, run_id, query_id, severity, code, detail, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    input.runId ?? null,
    input.queryId ?? null,
    input.severity,
    input.code,
    input.detail.slice(0, 4000),
    now,
    expiryIso(Number(env.DIAGNOSTIC_RETENTION_DAYS)),
  ).run();
}

async function capacityRatio(env: Env): Promise<number> {
  // D1 intentionally rejects page_count/page_size pragmas in production. This
  // conservative estimate includes stored text plus fixed row/index overhead;
  // operator backups provide the authoritative external size check.
  const statements = [
    "SELECT COALESCE(SUM(LENGTH(content_json) + 512), 0) AS bytes FROM catalogs",
    "SELECT COALESCE(SUM(LENGTH(query) + LENGTH(tags_json) + LENGTH(sources_json) + 512), 0) AS bytes FROM queries",
    "SELECT COUNT(*) * 1024 AS bytes FROM runs",
    "SELECT COALESCE(SUM(LENGTH(query) + LENGTH(tags_json) + LENGTH(sources_json) + LENGTH(packages_json) + 768), 0) AS bytes FROM run_queries",
    "SELECT COUNT(*) * 160 AS bytes FROM search_positions",
    "SELECT COALESCE(SUM(LENGTH(COALESCE(published_description, '')) + LENGTH(published_topics_json) + 2048), 0) AS bytes FROM package_snapshots",
    "SELECT COUNT(*) * 384 AS bytes FROM competitors",
    "SELECT COALESCE(SUM(LENGTH(COALESCE(published_description, '')) + LENGTH(published_topics_json) + LENGTH(rationale) + LENGTH(matched_terms_json) + 768), 0) AS bytes FROM competitor_classifications",
    "SELECT COALESCE(SUM(LENGTH(response_json) + 512), 0) AS bytes FROM competitor_backfills",
    "SELECT COALESCE(SUM(LENGTH(COALESCE(metadata_json,''))+LENGTH(COALESCE(score_json,''))+LENGTH(COALESCE(documentation_text,''))+LENGTH(analysis_json)+1024),0) AS bytes FROM competitor_registry",
    "SELECT COALESCE(SUM(LENGTH(metrics_json)+256),0) AS bytes FROM competitor_metric_observations",
    "SELECT COUNT(*)*512 AS bytes FROM competitor_discoveries",
    "SELECT COUNT(*)*512 AS bytes FROM intelligence_jobs",
    "SELECT COALESCE(SUM(LENGTH(decision_json)+512),0) AS bytes FROM competitor_reviews",
    "SELECT COALESCE(SUM(LENGTH(rationale) + LENGTH(evidence_json) + 512), 0) AS bytes FROM recommendations",
    "SELECT COALESCE(SUM(LENGTH(content) + 512), 0) AS bytes FROM report_artifacts",
    "SELECT COALESCE(SUM(LENGTH(content) + LENGTH(provenance_json) + 512), 0) AS bytes FROM legacy_documents",
    "SELECT COALESCE(SUM(LENGTH(verification_json) + 512), 0) AS bytes FROM migration_records",
    "SELECT COALESCE(SUM(LENGTH(body) + LENGTH(headers_json) + 512), 0) AS bytes FROM raw_http_bodies",
    "SELECT COALESCE(SUM(LENGTH(detail) + 384), 0) AS bytes FROM diagnostic_events",
  ];
  const results = await env.DB.batch<{ bytes: number }>(statements.map((sql) => env.DB.prepare(sql)));
  const estimatedBytes = results.reduce((total, result) => total + Number(result.results[0]?.bytes ?? 0), 0);
  const conservativeBytes = estimatedBytes * 1.5;
  return Math.max(0, conservativeBytes / Number(env.D1_CAPACITY_BYTES));
}

export async function enforceRetention(env: Env): Promise<RetentionState> {
  const ratio = await capacityRatio(env);
  const now = new Date().toISOString();
  if (ratio >= 0.7) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM raw_http_bodies WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM diagnostic_events WHERE expires_at < ?").bind(now),
    ]);
  }
  const state: RetentionState = {
    retain_raw: ratio < 0.85,
    pause_full: ratio >= 0.9,
    capacity_ratio: Number(ratio.toFixed(4)),
    last_pruned_at: ratio >= 0.7 ? now : undefined,
    warning: ratio >= 0.9
      ? "Full audits are paused because D1 reached 90% of the configured capacity. Public history was not deleted."
      : ratio >= 0.85
        ? "New raw HTTP bodies are disabled because D1 reached 85% of the configured capacity."
        : ratio >= 0.7
          ? "Expired internal artifacts were pruned because D1 reached 70% of the configured capacity."
          : undefined,
  };
  await env.DB.prepare(
    `INSERT INTO system_state (key, value_json, updated_at) VALUES ('retention', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).bind(JSON.stringify(state), now).run();
  return state;
}
