import { admitStartup, startupMessage, startupStatus, StartupQueueUnavailable } from "./startup.js";
import type { AuditProfile } from "../shared/types.js";
import { isD1DailyQuotaError, quotaResetDelay } from "./quota.js";
import { directoryResponse, packageResponse, exportReview, importReview } from "./intelligence.js";
import { canonicalizePackageSnapshots, compareQuerySets, type MovementQuery } from "../shared/movement.js";
import { activateBundledCatalog, syncCatalog } from "./catalog-store.js";
import type { LegacyImportPayload } from "../shared/types.js";
import { HistoryInputError, historyEvents, historySummary, validUtcDate } from "./history.js";
import { importLegacyDocument } from "./legacy-import.js";
import { enforceRetention, retentionState } from "./retention.js";
import { resumeFinalizers } from "./run-service.js";
import {
  PermanentCompetitorError,
  competitorClassificationSummary,
  reportedCompetitors,
} from "./competitors.js";
import {
  MUTABLE_CACHE_TAG,
  runCacheTag,
  withPublicCache,
} from "./cache.js";

const SECURITY_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { ...SECURITY_HEADERS, ...Object.fromEntries(new Headers(init.headers).entries()) },
  });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) difference |= leftHash[index] ^ rightHash[index];
  return difference === 0;
}

async function authorize(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  return constantTimeEqual(supplied, env.ADMIN_TOKEN);
}

async function bodyJson<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 1_000_000) throw new Error("Request body exceeds 1 MB.");
  const text = await request.text();
  if (text.length > 1_000_000) throw new Error("Request body exceeds 1 MB.");
  return JSON.parse(text) as T;
}

async function latestRun(env: Env, profile: "pulse" | "full"): Promise<Record<string, unknown> | null> {
  const run = await env.DB.prepare(
    `SELECT id, profile, catalog_version, report_date, requested_depth, effective_depth,
      status, query_count, completed_count, failed_count, created_at, completed_at
     FROM runs WHERE profile = ? AND report_materialized = 1
     ORDER BY report_date DESC, completed_at DESC LIMIT 1`,
  ).bind(profile).first<Record<string, unknown>>();
  if (!run) return null;
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
      SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END) AS top_1,
      SUM(CASE WHEN rank IS NOT NULL AND rank <= 3 THEN 1 ELSE 0 END) AS top_3,
      SUM(CASE WHEN rank IS NOT NULL AND rank <= 10 THEN 1 ELSE 0 END) AS top_10
     FROM run_queries WHERE run_id = ? AND lane = 'compact-core' AND status = 'complete'`,
  ).bind(run.id).first<Record<string, number>>();
  return { ...run, coverage: counts };
}

async function summary(env: Env): Promise<Response> {
  const [pulse, full, current, catalogState, storage, snapshot, recommendations] = await Promise.all([
    latestRun(env, "pulse"),
    latestRun(env, "full"),
    env.DB.prepare(
      `SELECT id, profile, status, report_date, query_count, completed_count, failed_count, updated_at
       FROM runs WHERE status IN ('creating', 'queued', 'running', 'finalizing')
       ORDER BY created_at DESC LIMIT 1`,
    ).first<Record<string, unknown>>(),
    env.DB.prepare("SELECT value_json, updated_at FROM system_state WHERE key = 'catalog_sync'").first<{ value_json: string; updated_at: string }>(),
    retentionState(env),
    env.DB.prepare(
      `SELECT ps.published_version, ps.published_at, ps.repository_version, ps.points,
        ps.max_points, ps.likes, ps.downloads_30d, ps.captured_at, ps.run_id
       FROM package_snapshots ps JOIN runs r ON r.id = ps.run_id
       WHERE r.report_materialized = 1
       ORDER BY r.report_date DESC,
         CASE WHEN r.trigger_source = 'migration' THEN 1 ELSE 0 END,
         ps.captured_at DESC LIMIT 1`,
    ).first<Record<string, unknown>>(),
    env.DB.prepare(
      `WITH latest_report AS (
         SELECT id FROM runs WHERE report_materialized = 1
         ORDER BY report_date DESC,
           CASE WHEN trigger_source = 'migration' THEN 1 ELSE 0 END,
           completed_at DESC LIMIT 1
       )
       SELECT rec.run_id, rec.query_id, rec.class, rec.priority, rec.rationale,
        rq.query, rq.rank, rq.requested_depth
       FROM recommendations rec
       JOIN run_queries rq ON rq.run_id = rec.run_id AND rq.query_id = rec.query_id
       JOIN latest_report latest ON latest.id = rec.run_id
       ORDER BY rec.priority ASC, rec.query_id ASC LIMIT 12`,
    ).all<Record<string, unknown>>(),
  ]);
  return json({
    service: "deeplinkx-visibility",
    latest: { pulse, full },
    active_run: current,
    package_snapshot: snapshot,
    recommendations: recommendations.results,
    catalog_sync: catalogState ? { ...JSON.parse(catalogState.value_json), updated_at: catalogState.updated_at } : null,
    storage,
    interpretation: "Rank is bounded pub.dev visibility, not search volume, traffic, conversion, popularity, revenue, or demand.",
  });
}

async function runs(env: Env, url: URL): Promise<Response> {
  const profile = url.searchParams.get("profile");
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 30)));
  const clause = profile === "pulse" || profile === "full" || profile === "legacy-mixed" ? "WHERE profile = ?" : "";
  const statement = env.DB.prepare(
    `SELECT id, profile, catalog_version, report_date, requested_depth, effective_depth,
      trigger_source, status, query_count, completed_count, failed_count, created_at, completed_at,
      report_materialized
     FROM runs ${clause} ORDER BY report_date DESC, created_at DESC LIMIT ?`,
  );
  const result = clause ? await statement.bind(profile, limit).all() : await statement.bind(limit).all();
  return json({ runs: result.results });
}

async function runDetail(env: Env, runId: string): Promise<Response> {
  const run = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first();
  if (!run) return errorResponse(404, "Run not found.");
  const snapshot = await env.DB.prepare(
    `SELECT published_version, published_at, published_description, published_topics_json,
      repository_version, repository_description, points, max_points, likes,
      downloads_30d, package_url, score_url, captured_at
     FROM package_snapshots WHERE run_id = ? ORDER BY captured_at DESC LIMIT 1`,
  ).bind(runId).first();
  const artifacts = await env.DB.prepare(
    "SELECT artifact_type, filename, content_type, content_hash, created_at FROM report_artifacts WHERE run_id = ? ORDER BY artifact_type",
  ).bind(runId).all();
  return json({ run, package_snapshot: snapshot, exports: artifacts.results });
}

async function queryRows(env: Env, runId: string, url: URL): Promise<Response> {
  const lane = url.searchParams.get("lane");
  const provider = url.searchParams.get("provider");
  const productArea = url.searchParams.get("product_area");
  const clauses = ["run_id = ?"];
  const bindings: unknown[] = [runId];
  if (lane) { clauses.push("lane = ?"); bindings.push(lane); }
  if (productArea) { clauses.push("product_area = ?"); bindings.push(productArea); }
  if (provider) { clauses.push("json_extract(tags_json, '$.provider') = ?"); bindings.push(provider); }
  const result = await env.DB.prepare(
    `SELECT query_id, query, lane, product_area, expression_type, product_fit, tags_json,
      sources_json, definition_hash, requested_depth, actual_depth, rank, pages_scanned,
      exhausted, status, retry_count, packages_json, error_code
     FROM run_queries WHERE ${clauses.join(" AND ")} ORDER BY lane, query LIMIT 1500`,
  ).bind(...bindings).all<Record<string, unknown>>();
  return json({ queries: result.results.map((row) => ({
    ...row,
    tags: JSON.parse(String(row.tags_json)),
    sources: JSON.parse(String(row.sources_json)),
    packages: JSON.parse(String(row.packages_json)),
    tags_json: undefined,
    sources_json: undefined,
    packages_json: undefined,
  })) });
}

const COMPETITOR_RELATIONSHIPS = ["direct", "adjacent", "noise", "unknown"] as const;

function selectedCompetitorRelationships(url: URL): Set<string> | null {
  const raw = url.searchParams.get("relationship");
  if (!raw || raw === "all") return null;
  const values = [...new Set(raw.split(",").filter(Boolean))];
  if (!values.length || values.some((value) => !COMPETITOR_RELATIONSHIPS.includes(value as typeof COMPETITOR_RELATIONSHIPS[number]))) {
    throw new HistoryInputError("relationship must contain direct, adjacent, noise, unknown, or all.");
  }
  return new Set(values);
}

async function tableRows(env: Env, table: "competitors" | "recommendations", runId: string, url?: URL): Promise<Response> {
  if (table === "competitors") {
    const selected = selectedCompetitorRelationships(url!);
    const [rows, classification] = await Promise.all([
      reportedCompetitors(env, runId),
      competitorClassificationSummary(env, runId),
    ]);
    const candidates = rows;
    return json({
      competitors: selected ? candidates.filter((row) => selected.has(row.relationship)) : candidates,
      classification,
    });
  }
  const rows = await env.DB.prepare(
    `SELECT rec.*, rq.query, rq.rank, rq.requested_depth
     FROM recommendations rec JOIN run_queries rq ON rq.run_id = rec.run_id AND rq.query_id = rec.query_id
     WHERE rec.run_id = ? ORDER BY rec.priority, rq.query LIMIT 1500`,
  ).bind(runId).all<Record<string, unknown>>();
  return json({ recommendations: rows.results.map((row) => ({ ...row, evidence: JSON.parse(String(row.evidence_json)), evidence_json: undefined })) });
}

interface PackageStatsRow {
  run_id: string;
  profile: string;
  report_date: string;
  trigger_source: string;
  published_version: string | null;
  published_at: string | null;
  repository_version: string | null;
  points: number | null;
  max_points: number | null;
  likes: number | null;
  downloads_30d: number | null;
  captured_at: string;
}

async function packageStats(env: Env, url: URL): Promise<Response> {
  const profile = url.searchParams.get("profile");
  if (profile && profile !== "pulse" && profile !== "full") return errorResponse(400, "Profile must be pulse or full.");
  const canonical = url.searchParams.get("canonical");
  if (canonical && canonical !== "1") return errorResponse(400, "canonical must be 1 when provided.");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from && !validUtcDate(from)) return errorResponse(400, "from must be a valid UTC date in YYYY-MM-DD format.");
  if (to && !validUtcDate(to)) return errorResponse(400, "to must be a valid UTC date in YYYY-MM-DD format.");
  if (from && to && from > to) return errorResponse(400, "from must be on or before to.");
  const clauses = ["r.report_materialized = 1", "ps.package_name = ?"];
  const bindings: unknown[] = [env.PACKAGE_NAME];
  if (profile) { clauses.push("r.profile = ?"); bindings.push(profile); }
  if (from) { clauses.push("r.report_date >= ?"); bindings.push(from); }
  if (to) { clauses.push("r.report_date <= ?"); bindings.push(to); }
  const columns = `ps.run_id, r.profile, r.report_date, r.trigger_source,
    ps.published_version, ps.published_at, ps.repository_version, ps.points,
    ps.max_points, ps.likes, ps.downloads_30d, ps.captured_at`;
  const sql = `SELECT ${columns}
    FROM package_snapshots ps JOIN runs r ON r.id = ps.run_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY r.report_date ASC, ps.captured_at ASC LIMIT 1000`;
  const result = await env.DB.prepare(sql).bind(...bindings).all<PackageStatsRow>();
  return json({
    snapshots: canonical === "1" ? canonicalizePackageSnapshots(result.results) : result.results,
    canonical: canonical === "1",
  });
}

async function queryHistory(env: Env, queryId: string, url: URL): Promise<Response> {
  const profile = url.searchParams.get("profile");
  const clause = profile === "pulse" || profile === "full" ? "AND r.profile = ?" : "";
  const statement = env.DB.prepare(
    `SELECT rq.query_id, rq.query, rq.definition_hash, rq.rank, rq.requested_depth,
      rq.actual_depth, rq.exhausted, rq.status, r.id AS run_id, r.profile,
      r.report_date, r.catalog_version
     FROM run_queries rq JOIN runs r ON r.id = rq.run_id
     WHERE rq.query_id = ? AND r.report_materialized = 1 ${clause}
     ORDER BY r.report_date ASC, r.completed_at ASC LIMIT 1000`,
  );
  const result = clause ? await statement.bind(queryId, profile).all() : await statement.bind(queryId).all();
  return json({ history: result.results });
}

async function comparison(env: Env, url: URL): Promise<Response> {
  const beforeId = url.searchParams.get("before");
  const afterId = url.searchParams.get("after");
  if (!beforeId || !afterId) return errorResponse(400, "Both before and after run IDs are required.");
  const [before, after] = await Promise.all([
    env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(beforeId).first<Record<string, unknown>>(),
    env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(afterId).first<Record<string, unknown>>(),
  ]);
  if (!before || !after) return errorResponse(404, "One or both comparison runs were not found.");
  if (before.profile !== after.profile || before.effective_depth !== after.effective_depth) {
    return errorResponse(409, "Runs must have the same profile and effective depth.");
  }
  if (!before.report_materialized || !after.report_materialized) return errorResponse(409, "Both reports must be materialized.");
  if (before.status !== "complete" || after.status !== "complete") return errorResponse(409, "Both comparison runs must be complete.");
  const [beforeRows, afterRows] = await Promise.all([
    env.DB.prepare("SELECT query_id, query, definition_hash, rank, requested_depth, actual_depth, exhausted, status FROM run_queries WHERE run_id = ?").bind(beforeId).all<MovementQuery>(),
    env.DB.prepare("SELECT query_id, query, definition_hash, rank, requested_depth, actual_depth, exhausted, status FROM run_queries WHERE run_id = ?").bind(afterId).all<MovementQuery>(),
  ]);
  const compared = compareQuerySets(beforeRows.results, afterRows.results);
  const unsupportedLosses = compared.movements.filter((item) => item.outcome === "withheld");
  const movementLabels = {
    improved: "IMPROVED",
    dropped: "DECLINED",
    found: "FOUND",
    lost_visibility: "LOST",
    unchanged: "UNCHANGED",
    not_visible: "NOT_VISIBLE",
    withheld: "WITHHELD",
  } as const;
  const movements = compared.movements
    .filter((item) => item.outcome !== "withheld")
    .map((item) => ({ ...item, movement: movementLabels[item.outcome] }));
  return json({
    before: { id: before.id, profile: before.profile, date: before.report_date, depth: before.effective_depth, catalog_version: before.catalog_version },
    after: { id: after.id, profile: after.profile, date: after.report_date, depth: after.effective_depth, catalog_version: after.catalog_version },
    movements,
    added: compared.added,
    retired: compared.retired,
    redefined: compared.redefined,
    unsupported_losses: unsupportedLosses,
    interpretation: "LOST is emitted only when the later completed query depth or result exhaustion establishes absence.",
  });
}

async function exportArtifact(env: Env, runId: string, format: string): Promise<Response> {
  if (!["markdown", "csv", "json"].includes(format)) return errorResponse(404, "Export format not found.");
  const artifact = await env.DB.prepare(
    "SELECT filename, content_type, content, content_hash FROM report_artifacts WHERE run_id = ? AND artifact_type = ?",
  ).bind(runId, format).first<{ filename: string; content_type: string; content: string; content_hash: string }>();
  if (!artifact) return errorResponse(404, "Export not found.");
  return new Response(artifact.content, {
    headers: {
      ...SECURITY_HEADERS,
      "content-type": artifact.content_type,
      "content-disposition": `inline; filename="${artifact.filename.replaceAll('"', "")}"`,
      etag: `"${artifact.content_hash}"`,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

async function legacyArchive(env: Env, documentId?: string): Promise<Response> {
  if (documentId) {
    const row = await env.DB.prepare(
      "SELECT id, document_type, filename, report_date, source_hash, content, provenance_json, imported_at FROM legacy_documents WHERE id = ?",
    ).bind(documentId).first<Record<string, unknown>>();
    if (!row) return errorResponse(404, "Legacy document not found.");
    return json({ document: { ...row, provenance: JSON.parse(String(row.provenance_json)), provenance_json: undefined } });
  }
  const rows = await env.DB.prepare(
    "SELECT id, document_type, filename, report_date, source_hash, imported_at FROM legacy_documents ORDER BY report_date DESC, filename",
  ).all();
  return json({ documents: rows.results });
}

async function runScopedResponse(
  env: Env,
  runId: string,
  producer: () => Promise<Response>,
  mutableDerived = false,
): Promise<Response> {
  const run = await env.DB.prepare(
    "SELECT status, report_materialized FROM runs WHERE id = ?",
  ).bind(runId).first<{ status: string; report_materialized: number }>();
  const response = await producer();
  if (run?.status === "incomplete") {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.delete("cloudflare-cdn-cache-control");
    headers.delete("cache-tag");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  const materialized = Boolean(run?.report_materialized);
  if (mutableDerived) {
    return withPublicCache(response, "mutable", [MUTABLE_CACHE_TAG, runCacheTag(runId)]);
  }
  return withPublicCache(
    response,
    materialized ? "immutable" : "live",
    materialized ? [] : [MUTABLE_CACHE_TAG, runCacheTag(runId)],
  );
}

export type InvalidatePublicCache = (tags: string[], runId?: string) => Promise<void>;

async function admin(
  request: Request,
  env: Env,
  path: string,
  invalidate: InvalidatePublicCache,
): Promise<Response> {
  if (!await authorize(request, env)) return errorResponse(401, "Unauthorized.");
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) return errorResponse(400, "A bounded Idempotency-Key header is required.");
  if (path === "/api/v1/admin/competitors/refresh" && request.method === "POST") {
    const body = await bodyJson<{run_id?:string; full?:boolean}>(request);
    if ((body.run_id !== undefined && (typeof body.run_id !== "string" || !body.run_id.trim() || body.run_id.length > 200)) || (body.full !== undefined && typeof body.full !== "boolean")) return errorResponse(400,"Invalid refresh scope.");
    const result = await admitStartup(env,await startupMessage({type:"refresh",runId:body.run_id?.trim(),full:body.full??true},idempotencyKey));
    await invalidate([MUTABLE_CACHE_TAG]);
    return json(result.body,{status:result.status,headers:{"cache-control":"no-store"}});
  }
  if (path === "/api/v1/admin/competitors/review/export" && request.method === "POST") {
    try {
      const body=await bodyJson<{packages:string[]}>(request);
      if (!Array.isArray(body.packages)) return errorResponse(400,"packages must be an array.");
      return json(await exportReview(env,body.packages),{headers:{"cache-control":"no-store"}});
    } catch (error) {if(isD1DailyQuotaError(error)) throw error;return errorResponse(400,error instanceof Error?error.message:"Invalid review request.");}
  }
  if (path === "/api/v1/admin/competitors/review/import" && request.method === "POST") {
    try {
      await importReview(env,await bodyJson<Parameters<typeof importReview>[1]>(request));
      await invalidate([MUTABLE_CACHE_TAG]);
      return json({status:"reviewed"},{headers:{"cache-control":"no-store"}});
    } catch (error) {if(isD1DailyQuotaError(error)) throw error;return errorResponse(400,error instanceof Error?error.message:"Invalid review request.");}
  }
  if (path === "/api/v1/admin/runs" && request.method === "POST") {
    const body = await bodyJson<{ profile?: AuditProfile }>(request);
    if (body.profile !== "pulse" && body.profile !== "full") return errorResponse(400, "Profile must be pulse or full.");
    const result = await admitStartup(env,await startupMessage({type:"run",profile:body.profile,triggerSource:"manual"},idempotencyKey));
    await invalidate([MUTABLE_CACHE_TAG]);
    return json(result.body,{status:result.status,headers:{"cache-control":"no-store"}});
  }
  if (path === "/api/v1/admin/catalog/sync" && request.method === "POST") {
    const body = await bodyJson<{ source?: "remote" | "bundled" }>(request);
    if (body.source && body.source !== "remote" && body.source !== "bundled") {
      return errorResponse(400, "Catalog source must be remote or bundled.");
    }
    const result = body.source === "bundled"
      ? { catalog: await activateBundledCatalog(env), warning: null }
      : await syncCatalog(env);
    await invalidate([MUTABLE_CACHE_TAG]);
    return json({ catalog_version: result.catalog.catalog_version, source: body.source ?? "remote", warning: result.warning }, { headers: { "cache-control": "no-store" } });
  }
  if (path === "/api/v1/admin/maintenance" && request.method === "POST") {
    const [retention, resumed_finalizers] = await Promise.all([enforceRetention(env), resumeFinalizers(env)]);
    await invalidate([MUTABLE_CACHE_TAG]);
    return json({ retention, resumed_finalizers }, { headers: { "cache-control": "no-store" } });
  }
  if (path === "/api/v1/admin/legacy/import" && request.method === "POST") {
    const result = await importLegacyDocument(env, await bodyJson<LegacyImportPayload>(request));
    await invalidate(
      [MUTABLE_CACHE_TAG],
      "run_id" in result && typeof result.run_id === "string" ? result.run_id : undefined,
    );
    return json(result, { status: result.status === "already-imported" ? 200 : 201, headers: { "cache-control": "no-store" } });
  }
  if (path === "/api/v1/admin/competitors/backfill" && request.method === "POST") {
    const body = await bodyJson<{ run_id?: string }>(request);
    if (body.run_id !== undefined && (typeof body.run_id !== "string" || !body.run_id.trim() || body.run_id.length > 200)) {
      return errorResponse(400, "run_id must be a bounded non-empty string when provided.");
    }
    const result = await admitStartup(env,await startupMessage({type:"backfill",runId:body.run_id?.trim()},idempotencyKey));
    await invalidate([MUTABLE_CACHE_TAG]);
    return json(result.body,{status:result.status,headers:{"cache-control":"no-store"}});
  }
  return errorResponse(404, "Admin endpoint not found.");
}

export async function handlePublicApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (request.method !== "GET") return errorResponse(405, "Method not allowed.");
    if (path === "/api/v1/competitors") {
      try { return withPublicCache(json(await directoryResponse(env,url)),"mutable",[MUTABLE_CACHE_TAG]); }
      catch (error) { if(isD1DailyQuotaError(error)) throw error; return errorResponse(400,error instanceof Error?error.message:"Invalid filters."); }
    }
    const packageMatch=path.match(/^\/api\/v1\/competitors\/([a-z][a-z0-9_]*)$/);
    if (packageMatch) {
      const result=await packageResponse(env,packageMatch[1]);
      return result ? withPublicCache(json(result),"mutable",[MUTABLE_CACHE_TAG]) : errorResponse(404,"Package not found.");
    }
    if (path === "/api/v1/summary") return withPublicCache(await summary(env), "live", [MUTABLE_CACHE_TAG]);
    if (path === "/api/v1/runs") return withPublicCache(await runs(env, url), "live", [MUTABLE_CACHE_TAG]);
    if (path === "/api/v1/stats") return withPublicCache(await packageStats(env, url), "mutable", [MUTABLE_CACHE_TAG]);
    if (path === "/api/v1/history/summary") {
      return withPublicCache(json(await historySummary(env, url)), "mutable", [MUTABLE_CACHE_TAG]);
    }
    if (path === "/api/v1/history/events") {
      return withPublicCache(json(await historyEvents(env, url)), "mutable", [MUTABLE_CACHE_TAG]);
    }
    if (path === "/api/v1/compare") return withPublicCache(await comparison(env, url), "immutable");
    if (path === "/api/v1/legacy") return withPublicCache(await legacyArchive(env), "mutable", [MUTABLE_CACHE_TAG]);
    const legacyMatch = path.match(/^\/api\/v1\/legacy\/([^/]+)$/);
    if (legacyMatch) return withPublicCache(await legacyArchive(env, legacyMatch[1]), "immutable");
    const runMatch = path.match(/^\/api\/v1\/runs\/([^/]+)$/);
    if (runMatch) return runScopedResponse(env, runMatch[1], () => runDetail(env, runMatch[1]));
    const queryMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/queries$/);
    if (queryMatch) return runScopedResponse(env, queryMatch[1], () => queryRows(env, queryMatch[1], url));
    const historyMatch = path.match(/^\/api\/v1\/queries\/([^/]+)\/history$/);
    if (historyMatch) {
      return withPublicCache(await queryHistory(env, historyMatch[1], url), "mutable", [MUTABLE_CACHE_TAG]);
    }
    const competitorMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/competitors$/);
    if (competitorMatch) {
      return await runScopedResponse(
        env,
        competitorMatch[1],
        () => tableRows(env, "competitors", competitorMatch[1], url),
        true,
      );
    }
    const recommendationMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/recommendations$/);
    if (recommendationMatch) {
      return runScopedResponse(env, recommendationMatch[1], () => tableRows(env, "recommendations", recommendationMatch[1]));
    }
    const exportMatch = path.match(/^\/api\/v1\/exports\/([^/]+)\/(markdown|csv|json)$/);
    if (exportMatch) return withPublicCache(await exportArtifact(env, exportMatch[1], exportMatch[2]), "immutable");
    return errorResponse(404, "API endpoint not found.");
  } catch (error) {
    if (isD1DailyQuotaError(error)) return quotaUnavailable();
    if (error instanceof HistoryInputError) return errorResponse(error.status, error.message);
    return errorResponse(500, error instanceof Error ? error.message : "Unexpected service error.");
  }
}

export async function handleUncachedApi(
  request: Request,
  env: Env,
  invalidate: InvalidatePublicCache,
): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  try {
    if (path.startsWith("/api/v1/admin/")) return await admin(request, env, path, invalidate);
    if (request.method !== "GET") return errorResponse(405, "Method not allowed.");
    const operationMatch = path.match(/^\/api\/v1\/operations\/([a-f0-9]{64})$/);
    if (operationMatch) {
      const operation = await startupStatus(env,operationMatch[1]);
      return operation ? json(operation,{headers:{"cache-control":"no-store"}}) : errorResponse(404,"No database record yet. A queued request may not appear until database access returns; otherwise check the operation ID.");
    }
    if (path === "/api/v1/health") {
      const active = await env.DB.prepare("SELECT catalog_version FROM catalogs WHERE is_active = 1").first();
      return json(
        { status: "ok", database: "reachable", active_catalog: active },
        { headers: { "cache-control": "no-store" } },
      );
    }
    return errorResponse(404, "API endpoint not found.");
  } catch (error) {
    if (isD1DailyQuotaError(error)) return quotaUnavailable();
    if (error instanceof StartupQueueUnavailable) return json({error:error.message},{status:503,headers:{"cache-control":"no-store","retry-after":"60"}});
    if (error instanceof PermanentCompetitorError) {
      return errorResponse(error.code.endsWith("idempotency-conflict") ? 409 : 400, error.message);
    }
    return errorResponse(500, error instanceof Error ? error.message : "Unexpected service error.");
  }
}

function quotaUnavailable(): Response {
  return json({error:"Cloudflare D1 daily quota reached. Queued work resumes after the UTC daily reset."},{status:503,headers:{"cache-control":"no-store","retry-after":String(quotaResetDelay())}});
}
