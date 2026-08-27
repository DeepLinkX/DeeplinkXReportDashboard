import { PROFILE_DEPTH, sha256Hex, stableJson } from "../shared/catalog.js";
import type { AuditProfile, AuditQueueMessage, CatalogManifest, QueryDefinition } from "../shared/types.js";
import { activeCatalog, selectCatalogQueries } from "./catalog-store.js";
import { enforceRetention, recordDiagnostic, storeRawBody } from "./retention.js";

const STATEMENT_CHUNK = 75;
const QUEUE_CHUNK = 100;

interface RunRow {
  id: string;
  profile: AuditProfile;
  status: string;
  query_count: number;
  completed_count: number;
  failed_count: number;
  report_date: string;
  requested_depth: number;
  effective_depth: number | null;
  catalog_version: string;
  created_at: string;
  completed_at: string | null;
}

interface PackageApi {
  latest?: {
    version?: string;
    published?: string;
    pubspec?: { description?: string; topics?: string[] };
  };
}

interface ScoreApi {
  grantedPoints?: number;
  maxPoints?: number;
  likeCount?: number;
  downloadCount30Days?: number;
}

function utcDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function groups<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

async function queryDefinitionHash(query: QueryDefinition): Promise<string> {
  const material = stableJson({
    query: query.query,
    lane: query.lane,
    product_area: query.product_area,
    expression_type: query.expression_type,
    product_fit: query.product_fit,
    tags: query.tags,
    sources: query.sources,
  });
  return sha256Hex(material);
}

async function fetchCaptured(
  env: Env,
  runId: string,
  purpose: string,
  url: string,
): Promise<{ response: Response; body: string }> {
  const response = await fetch(url, {
    headers: { accept: purpose.includes("page") ? "text/html" : "application/json", "user-agent": "deeplinkx-visibility/1.0" },
  });
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 1_000_000) throw new Error(`${purpose} exceeded the 1 MB response limit.`);
  const body = await response.text();
  if (body.length > 1_000_000) throw new Error(`${purpose} exceeded the 1 MB response limit.`);
  await storeRawBody(env, { runId, purpose, sourceUrl: url, response, body });
  if (!response.ok) throw new Error(`${purpose} returned HTTP ${response.status}.`);
  return { response, body };
}

async function capturePackageSnapshot(env: Env, runId: string, catalog: CatalogManifest): Promise<void> {
  const packageUrl = `https://pub.dev/api/packages/${encodeURIComponent(env.PACKAGE_NAME)}`;
  const scoreUrl = `${packageUrl}/score`;
  const packagePageUrl = `https://pub.dev/packages/${encodeURIComponent(env.PACKAGE_NAME)}`;
  const scorePageUrl = `${packagePageUrl}/score`;
  const [packageApiResult, scoreApiResult] = await Promise.all([
    fetchCaptured(env, runId, "package-metadata", packageUrl),
    fetchCaptured(env, runId, "score-metadata", scoreUrl),
    fetchCaptured(env, runId, "package-page", packagePageUrl),
    fetchCaptured(env, runId, "score-page", scorePageUrl),
  ]);
  const packageApi = JSON.parse(packageApiResult.body) as PackageApi;
  const scoreApi = JSON.parse(scoreApiResult.body) as ScoreApi;
  const latest = packageApi.latest ?? {};
  const pubspec = latest.pubspec ?? {};
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO package_snapshots (
      id, run_id, package_name, published_version, published_at, published_description,
      published_topics_json, repository_version, repository_description, points, max_points,
      likes, downloads_30d, package_url, score_url, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    runId,
    env.PACKAGE_NAME,
    latest.version ?? null,
    latest.published ?? null,
    pubspec.description ?? null,
    JSON.stringify(pubspec.topics ?? []),
    catalog.product.repository_version,
    catalog.product.repository_description,
    scoreApi.grantedPoints ?? null,
    scoreApi.maxPoints ?? null,
    scoreApi.likeCount ?? null,
    scoreApi.downloadCount30Days ?? null,
    packagePageUrl,
    scorePageUrl,
    now,
  ).run();
}

async function existingRun(env: Env, idempotencyKey: string): Promise<RunRow | null> {
  return env.DB.prepare("SELECT * FROM runs WHERE idempotency_key = ?").bind(idempotencyKey).first<RunRow>();
}

async function insertSkippedPulse(
  env: Env,
  catalog: CatalogManifest,
  reportDate: string,
  idempotencyKey: string,
  triggerSource: string,
): Promise<RunRow> {
  const duplicate = await existingRun(env, idempotencyKey);
  if (duplicate) return duplicate;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO runs (
      id, profile, catalog_version, report_date, requested_depth, effective_depth,
      trigger_source, idempotency_key, status, query_count, completed_count,
      failed_count, completed_at, created_at, updated_at, error_summary
    ) VALUES (?, 'pulse', ?, ?, 10, 10, ?, ?, 'skipped', 0, 0, 0, ?, ?, ?, ?)`,
  ).bind(
    id,
    catalog.catalog_version,
    reportDate,
    triggerSource,
    idempotencyKey,
    now,
    now,
    now,
    "Skipped because a full audit was active or already completed on the same UTC date.",
  ).run();
  return (await existingRun(env, idempotencyKey))!;
}

export async function createRun(
  env: Env,
  input: {
    profile: "pulse" | "full";
    idempotencyKey: string;
    triggerSource: "cron" | "manual" | "migration";
    date?: Date;
  },
): Promise<RunRow> {
  const duplicate = await existingRun(env, input.idempotencyKey);
  if (duplicate) return duplicate;
  const catalog = await activeCatalog(env);
  const reportDate = utcDate(input.date);
  const active = await env.DB.prepare(
    "SELECT id FROM runs WHERE profile = ? AND status IN ('creating', 'queued', 'running', 'finalizing') LIMIT 1",
  ).bind(input.profile).first<{ id: string }>();
  if (active) throw new Error(`An active ${input.profile} run already exists (${active.id}).`);
  const reportForDate = await env.DB.prepare(
    `SELECT id FROM runs WHERE profile = ? AND report_date = ?
     AND trigger_source != 'migration' AND report_materialized = 1 LIMIT 1`,
  ).bind(input.profile, reportDate).first<{ id: string }>();
  if (reportForDate) throw new Error(`A materialized ${input.profile} report already exists for ${reportDate} (${reportForDate.id}).`);

  if (input.profile === "pulse") {
    const fullToday = await env.DB.prepare(
      `SELECT id FROM runs
       WHERE profile = 'full' AND report_date = ?
         AND status IN ('creating', 'queued', 'running', 'finalizing', 'complete')
       LIMIT 1`,
    ).bind(reportDate).first<{ id: string }>();
    if (fullToday) return insertSkippedPulse(env, catalog, reportDate, input.idempotencyKey, input.triggerSource);
  }

  const retention = await enforceRetention(env);
  if (input.profile === "full" && retention.pause_full) {
    throw new Error(retention.warning ?? "Full audits are paused by the storage guard.");
  }
  const selected = selectCatalogQueries(catalog, input.profile);
  const configuredLimit = Number(input.profile === "pulse" ? env.PULSE_QUERY_LIMIT : env.FULL_QUERY_LIMIT);
  if (selected.length > configuredLimit) {
    throw new Error(`${input.profile} catalog has ${selected.length} queries, exceeding the ${configuredLimit} query budget.`);
  }

  const runId = crypto.randomUUID();
  const depth = PROFILE_DEPTH[input.profile];
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO runs (
        id, profile, catalog_version, report_date, requested_depth, trigger_source,
        idempotency_key, status, query_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)`,
    ).bind(
      runId,
      input.profile,
      catalog.catalog_version,
      reportDate,
      depth,
      input.triggerSource,
      input.idempotencyKey,
      selected.length,
      now,
      now,
    ).run();
  } catch (error) {
    const raced = await existingRun(env, input.idempotencyKey);
    if (raced) return raced;
    throw error;
  }

  const queryStatements = await Promise.all(selected.map(async (query) => env.DB.prepare(
    `INSERT INTO run_queries (
      run_id, query_id, query, lane, product_area, expression_type, product_fit,
      tags_json, sources_json, definition_hash, requested_depth, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
  ).bind(
    runId,
    query.query_id,
    query.query,
    query.lane,
    query.product_area,
    query.expression_type,
    query.product_fit,
    JSON.stringify(query.tags),
    JSON.stringify(query.sources),
    await queryDefinitionHash(query),
    depth,
    now,
  )));
  for (const group of groups(queryStatements, STATEMENT_CHUNK)) await env.DB.batch(group);

  try {
    await capturePackageSnapshot(env, runId, catalog);
  } catch (error) {
    await recordDiagnostic(env, {
      runId,
      severity: "warning",
      code: "package-snapshot-failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const messages = selected.map((query) => ({ body: { kind: "scan-query", runId, queryId: query.query_id } satisfies AuditQueueMessage }));
  try {
    for (const group of groups(messages, QUEUE_CHUNK)) await env.SCAN_QUEUE.sendBatch(group);
    await env.DB.batch([
      env.DB.prepare("UPDATE run_queries SET status = 'queued', updated_at = ? WHERE run_id = ? AND status = 'planned'").bind(now, runId),
      env.DB.prepare("UPDATE runs SET status = 'queued', started_at = ?, updated_at = ? WHERE id = ?").bind(now, now, runId),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(
      "UPDATE runs SET status = 'incomplete', error_summary = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    ).bind(`Queue creation failed: ${detail}`, now, now, runId).run();
    await recordDiagnostic(env, { runId, severity: "error", code: "queue-creation-failed", detail });
    throw error;
  }
  return (await existingRun(env, input.idempotencyKey))!;
}

export async function updateRunProgress(env: Env, runId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE runs SET
      completed_count = (SELECT COUNT(*) FROM run_queries WHERE run_id = ? AND status = 'complete'),
      failed_count = (SELECT COUNT(*) FROM run_queries WHERE run_id = ? AND status = 'failed'),
      status = CASE WHEN status IN ('queued', 'creating') THEN 'running' ELSE status END,
      updated_at = ?
     WHERE id = ?`,
  ).bind(runId, runId, now, runId).run();
}

export async function enqueueFinalizerIfReady(env: Env, runId: string): Promise<void> {
  await updateRunProgress(env, runId);
  const run = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first<RunRow>();
  if (!run || run.completed_count + run.failed_count !== run.query_count) return;
  const now = new Date().toISOString();
  const changed = await env.DB.prepare(
    `UPDATE runs SET status = 'finalizing', updated_at = ?
     WHERE id = ? AND status IN ('queued', 'running', 'incomplete') AND report_materialized = 0`,
  ).bind(now, runId).run();
  if (!changed.meta.changes) return;
  try {
    await env.SCAN_QUEUE.send({ kind: "finalize-run", runId } satisfies AuditQueueMessage);
  } catch (error) {
    await env.DB.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'finalizing'").bind(now, runId).run();
    throw error;
  }
}

export async function markDeadLetter(env: Env, message: AuditQueueMessage, detail: string): Promise<void> {
  const now = new Date().toISOString();
  if (message.kind === "scan-query") {
    await env.DB.prepare(
      `UPDATE run_queries SET status = 'failed', error_code = 'dead-letter',
       error_message = ?, completed_at = ?, updated_at = ?
       WHERE run_id = ? AND query_id = ? AND status != 'complete'`,
    ).bind(detail.slice(0, 1000), now, now, message.runId, message.queryId).run();
    await recordDiagnostic(env, { runId: message.runId, queryId: message.queryId, severity: "error", code: "dead-letter", detail });
    await enqueueFinalizerIfReady(env, message.runId);
    return;
  }
  await env.DB.prepare(
    `UPDATE runs SET status = 'incomplete', error_summary = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND status != 'complete'`,
  ).bind(`Report finalization reached the dead-letter queue: ${detail}`.slice(0, 1000), now, now, message.runId).run();
  await recordDiagnostic(env, { runId: message.runId, severity: "error", code: "finalizer-dead-letter", detail });
}

export async function resumeFinalizers(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM runs WHERE status IN ('running', 'incomplete') AND report_materialized = 0
     AND query_count = completed_count + failed_count`,
  ).all<{ id: string }>();
  for (const row of rows.results) await enqueueFinalizerIfReady(env, row.id);
  return rows.results.length;
}
