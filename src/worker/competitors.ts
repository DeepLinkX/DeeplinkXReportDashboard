import bundledCatalog from "../../catalog/catalog-v3.json";
import { analyzePackage, ANALYSIS_VERSION } from "../shared/competitor-analysis.js";
import type { ProductCapability } from "../shared/intelligence.js";
import { refreshPackage } from "./intelligence.js";
import type { CapabilityMatch, IntelligencePackage } from "../shared/intelligence.js";
import { semanticText } from "../shared/catalog.js";
import type { CompetitorRelationship } from "../shared/types.js";
import { retryDelay } from "./scanner.js";
import { recordDiagnostic, storeRawBody } from "./retention.js";

export const COMPETITOR_CLASSIFIER_VERSION = ANALYSIS_VERSION;


const STATEMENT_CHUNK = 75;
const QUEUE_CHUNK = 100;

export interface CompetitorRow {
  package_name: string;
  occurrence_count: number;
  best_rank: number;
  median_rank: number;
  category: string;
}

export interface ReportedCompetitorRow extends CompetitorRow {
  classification_status: string;
  relationship: CompetitorRelationship;
  capability_category: string;
  classifier_version: string | null;
  published_version: string | null;
  published_description: string | null;
  published_topics: string[];
  metadata_captured_at: string | null;
  rationale: string;
  matched_terms: string[];
  relevant_occurrence_count: number;
  relevant_best_rank: number | null;
  relevant_median_rank: number | null;
}

export interface CompetitorMetadata {
  packageName: string;
  version: string | null;
  description: string;
  topics: string[];
}

export interface CompetitorClassification {
  relationship: CompetitorRelationship;
  capabilityCategory: string;
  rationale: string;
  matchedTerms: string[];
  capabilities?: CapabilityMatch[];
}

export interface CompetitorQueryEvidence {
  position: number;
  query: string;
  lane: string;
  productArea: string;
  tags: Record<string, string>;
}

export interface RelevantCompetitorMetrics {
  occurrenceCount: number;
  bestRank: number | null;
  medianRank: number | null;
}

interface PackageApi {
  name?: string;
  latest?: {
    version?: string;
    pubspec?: { description?: string; topics?: string[] };
  };
}

interface ClassificationStateRow {
  total: number;
  planned: number;
  queued: number;
  running: number;
  complete: number;
  failed: number;
}

export interface CompetitorClassificationSummary {
  status: "complete" | "partial" | "pending" | "not_started" | "unavailable";
  classifier_version: string;
  raw_competitor_count: number;
  candidate_count: number;
  complete_count: number;
  failed_count: number;
  pending_count: number;
  relationship_counts: Record<CompetitorRelationship, number>;
  reason?: string;
}

export interface CompetitorBackfillResult {
  status: "accepted";
  started_runs: string[];
  unavailable_runs: string[];
  enqueued_count: number;
  already_started?: boolean;
}

export class RetryableCompetitorError extends Error {
  constructor(message: string, readonly delaySeconds: number, readonly code: string) {
    super(message);
    this.name = "RetryableCompetitorError";
  }
}

export class PermanentCompetitorError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "PermanentCompetitorError";
  }
}

export function classifyCompetitor(metadata: CompetitorMetadata): CompetitorClassification {
  const result=analyzePackage({name:metadata.packageName,description:metadata.description,topics:metadata.topics,
    source_url:`https://pub.dev/api/packages/${metadata.packageName}`},bundledCatalog.capabilities as ProductCapability[]);
  return {relationship:result.relationship,capabilityCategory:result.capability_category,rationale:result.rationale,matchedTerms:result.actions,capabilities:result.capabilities};
}

function relevantEvidence(item: CompetitorQueryEvidence, capabilityCategory: string): boolean {
  const query = semanticText(item.query);
  switch (capabilityCategory) {
    case "map/navigation launcher":
      return item.productArea === "maps-navigation" || item.lane === "navigation" || Boolean(item.tags.capability);
    case "store redirect and fallback":
      return item.productArea === "stores-fallbacks" || item.lane === "store";
    case "provider-specific app linking":
      return ["provider", "action", "cross-cutting"].includes(item.lane)
        || ["app-launching", "category"].includes(item.productArea);
    case "external app launcher":
      return ["app-launching", "category", "features-comparisons"].includes(item.productArea)
        || ["provider", "action"].includes(item.lane);
    case "general URL launcher":
      return ["app-launching", "category", "features-comparisons"].includes(item.productArea);
    case "inbound links/routing":
    case "deep links":
      return item.productArea === "category" || (item.lane === "structured" && /(?:deep link|deeplink|app links)/.test(query));
    case "dynamic/deferred links":
      return item.productArea === "category" || /(?:dynamic|deferred|fallback)/.test(query);
    case "app availability":
      return item.productArea === "features-comparisons" || /(?:installed|availability)/.test(query);
    default:
      return false;
  }
}

export function relevantCompetitorMetrics(
  evidence: CompetitorQueryEvidence[],
  result: CompetitorClassification,
): RelevantCompetitorMetrics {
  if (result.relationship === "noise" || result.relationship === "unknown") {
    return { occurrenceCount: 0, bestRank: null, medianRank: null };
  }
  const positions = evidence
    .filter((item) => {
      if (!result.capabilities?.length) return relevantEvidence(item, result.capabilityCategory);
      const provider = item.tags.provider ?? item.tags.store;
      const matches = result.capabilities.filter((c) => c.provider === "General" ? relevantEvidence(item, result.capabilityCategory) : !provider || semanticText(c.provider) === semanticText(provider));
      if (!matches.length) return false;
      if (provider) {
        const action = item.tags.action ?? item.tags.capability;
        if (!action || item.lane === "provider" || item.lane === "store") return true;
        const actionWords=(value:string)=>semanticText(value.replace(/([a-z])([A-Z])/g,"$1 $2")).replace(semanticText(provider),"").replace(/\b(launch|open|action|the|a|by|with)\b/g," ").replace(/\s+/g," ").trim();
        return matches.some((c) => c.provider === "General" && relevantEvidence(item,result.capabilityCategory) || actionWords(c.action) === actionWords(action) || c.action === action || c.deeplinkx_apis.some((api) => api.endsWith(`.${action}`))
          || (c.action === "shareText" && /share|message/i.test(action) && !/file|image/i.test(action))
          || (c.action === "chat" && /chat/i.test(action)));
      }
      return relevantEvidence(item, result.capabilityCategory);
    })
    .map((item) => item.position)
    .sort((left, right) => left - right);
  if (!positions.length) return { occurrenceCount: 0, bestRank: null, medianRank: null };
  const midpoint = Math.floor(positions.length / 2);
  const median = positions.length % 2 ? positions[midpoint] : (positions[midpoint - 1] + positions[midpoint]) / 2;
  return { occurrenceCount: positions.length, bestRank: positions[0], medianRank: median };
}

function competitorCategory(productArea: string): string {
  const categories: Record<string, string> = {
    "maps-navigation": "map/navigation launcher",
    "stores-fallbacks": "store redirect and fallback",
    "app-launching": "external app launcher",
    "features-comparisons": "features and alternatives",
    category: "deep links",
    app: "provider-specific app linking",
    "provider-action": "provider action",
    "sdk-filter": "Flutter SDK filter",
    topic: "pub.dev topic",
  };
  return categories[productArea] ?? productArea;
}

export async function aggregateCompetitors(env: Env, runId: string): Promise<CompetitorRow[]> {
  const result = await env.DB.prepare(
    `WITH ranked AS (
      SELECT sp.package_name, sp.position, rq.product_area,
        ROW_NUMBER() OVER (PARTITION BY sp.package_name ORDER BY sp.position) AS position_order,
        COUNT(*) OVER (PARTITION BY sp.package_name) AS position_count
      FROM search_positions sp
      JOIN run_queries rq ON rq.run_id = sp.run_id AND rq.query_id = sp.query_id
      WHERE sp.run_id = ? AND sp.package_name != ?
    ), summaries AS (
      SELECT package_name,
        COUNT(*) AS occurrence_count,
        MIN(position) AS best_rank,
        AVG(CASE WHEN position_order IN ((position_count + 1) / 2, (position_count + 2) / 2) THEN position END) AS median_rank
      FROM ranked
      GROUP BY package_name
    ), areas AS (
      SELECT package_name, product_area,
        ROW_NUMBER() OVER (PARTITION BY package_name ORDER BY COUNT(*) DESC, product_area) AS area_order
      FROM ranked
      GROUP BY package_name, product_area
    )
    SELECT summaries.package_name, summaries.occurrence_count, summaries.best_rank,
      summaries.median_rank, areas.product_area AS category
    FROM summaries
    JOIN areas ON areas.package_name = summaries.package_name AND areas.area_order = 1
    ORDER BY summaries.occurrence_count DESC, summaries.best_rank ASC, summaries.package_name ASC`,
  ).bind(runId, env.PACKAGE_NAME).all<CompetitorRow>();
  return result.results.map((row) => ({ ...row, category: competitorCategory(row.category) }));
}

export async function upsertCompetitors(env: Env, runId: string, competitors: CompetitorRow[]): Promise<void> {
  const statements = competitors.map((row) => env.DB.prepare(
    `INSERT INTO competitors (run_id, package_name, occurrence_count, best_rank, median_rank, category)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, package_name) DO UPDATE SET
       occurrence_count = excluded.occurrence_count,
       best_rank = excluded.best_rank,
       median_rank = excluded.median_rank,
       category = excluded.category`,
  ).bind(runId, row.package_name, row.occurrence_count, row.best_rank, row.median_rank, row.category));
  for (let index = 0; index < statements.length; index += STATEMENT_CHUNK) {
    await env.DB.batch(statements.slice(index, index + STATEMENT_CHUNK));
  }
}

export async function reportedCompetitors(env: Env, runId: string): Promise<ReportedCompetitorRow[]> {
  const rows = await env.DB.prepare(
    `SELECT c.package_name, c.occurrence_count, c.best_rank, c.median_rank, c.category,
      COALESCE(cc.status, 'unavailable') AS classification_status,
      COALESCE(cc.relationship, 'unknown') AS relationship,
      COALESCE(cc.capability_category, 'other') AS capability_category,
      cc.classifier_version, cc.published_version, cc.published_description,
      COALESCE(cc.published_topics_json, '[]') AS published_topics_json,
      cc.metadata_captured_at,
      COALESCE(cc.rationale, 'No preserved package metadata is available for classification.') AS rationale,
      COALESCE(cc.matched_terms_json, '[]') AS matched_terms_json,
      COALESCE(cc.relevant_occurrence_count, 0) AS relevant_occurrence_count,
      cc.relevant_best_rank, cc.relevant_median_rank
     FROM competitors c
     LEFT JOIN competitor_classifications cc ON cc.run_id = c.run_id AND cc.package_name = c.package_name
     WHERE c.run_id = ?
     ORDER BY c.occurrence_count DESC, c.best_rank, c.package_name`,
  ).bind(runId).all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    package_name: String(row.package_name),
    occurrence_count: Number(row.occurrence_count),
    best_rank: Number(row.best_rank),
    median_rank: Number(row.median_rank),
    category: String(row.category),
    classification_status: String(row.classification_status),
    relationship: row.relationship as CompetitorRelationship,
    capability_category: String(row.capability_category),
    classifier_version: row.classifier_version === null ? null : String(row.classifier_version),
    published_version: row.published_version === null ? null : String(row.published_version),
    published_description: row.published_description === null ? null : String(row.published_description),
    published_topics: JSON.parse(String(row.published_topics_json)) as string[],
    metadata_captured_at: row.metadata_captured_at === null ? null : String(row.metadata_captured_at),
    rationale: String(row.rationale),
    matched_terms: JSON.parse(String(row.matched_terms_json)) as string[],
    relevant_occurrence_count: Number(row.relevant_occurrence_count),
    relevant_best_rank: row.relevant_best_rank === null ? null : Number(row.relevant_best_rank),
    relevant_median_rank: row.relevant_median_rank === null ? null : Number(row.relevant_median_rank),
  }));
}

export async function competitorClassificationSummary(
  env: Env,
  runId: string,
): Promise<CompetitorClassificationSummary> {
  const [raw, run] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM competitors WHERE run_id = ?",
    ).bind(runId).first<{ count: number }>(),
    env.DB.prepare(
      "SELECT trigger_source, report_materialized FROM runs WHERE id = ?",
    ).bind(runId).first<{ trigger_source: string; report_materialized: number }>(),
  ]);
  const rawCount = Number(raw?.count ?? 0);
  const state = await classificationState(env, runId);
  const relationshipRows = await env.DB.prepare(
    `SELECT relationship, COUNT(*) AS count FROM competitor_classifications
     WHERE run_id = ? GROUP BY relationship`,
  ).bind(runId).all<{ relationship: CompetitorRelationship; count: number }>();
  const relationshipCounts: Record<CompetitorRelationship, number> = { direct: 0, adjacent: 0, noise: 0, unknown: 0 };
  for (const row of relationshipRows.results) relationshipCounts[row.relationship] = Number(row.count);
  relationshipCounts.unknown += Math.max(0, rawCount - state.total);
  const pendingCount = state.planned + state.queued + state.running;
  const base = {
    classifier_version: COMPETITOR_CLASSIFIER_VERSION,
    raw_competitor_count: rawCount,
    candidate_count: state.total,
    complete_count: state.complete,
    failed_count: state.failed,
    pending_count: pendingCount,
    relationship_counts: relationshipCounts,
  };
  if (rawCount === 0 && run?.trigger_source === "migration") {
    return {
      status: "unavailable",
      ...base,
      reason: "This report has no preserved non-DeeplinkX package positions, so historical competitors cannot be reconstructed honestly.",
    };
  }
  if (rawCount === 0 && run?.report_materialized) return { status: "complete", ...base };
  if (state.total === 0) {
    return { status: "not_started", ...base, reason: "Competitor metadata classification has not been started for this report." };
  }
  if (state.total < rawCount || pendingCount > 0) {
    return { status: "pending", ...base, reason: "Competitor metadata classification is still running." };
  }
  if (state.failed > 0) {
    return { status: "partial", ...base, reason: "Some package metadata was unavailable; those packages remain unknown." };
  }
  return { status: "complete", ...base };
}

async function classificationState(env: Env, runId: string): Promise<ClassificationStateRow> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
      SUM(status = 'planned') AS planned,
      SUM(status = 'queued') AS queued,
      SUM(status = 'running') AS running,
      SUM(status = 'complete') AS complete,
      SUM(status = 'failed') AS failed
     FROM competitor_classifications WHERE run_id = ?`,
  ).bind(runId).first<Record<string, number>>();
  return {
    total: Number(row?.total ?? 0),
    planned: Number(row?.planned ?? 0),
    queued: Number(row?.queued ?? 0),
    running: Number(row?.running ?? 0),
    complete: Number(row?.complete ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

export async function ensureCompetitorClassifications(
  env: Env,
  runId: string,
): Promise<{ candidateCount: number; pendingCount: number; failedCount: number; enqueuedCount: number }> {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO competitor_classifications (
    run_id,package_name,status,relationship,capability_category,classifier_version,package_url,updated_at)
    SELECT run_id,package_name,'planned','unknown','other',?,'https://pub.dev/packages/'||package_name,? FROM competitors WHERE run_id=?
    ON CONFLICT(run_id,package_name) DO UPDATE SET status='planned',classifier_version=excluded.classifier_version
    WHERE competitor_classifications.classifier_version!=excluded.classifier_version`)
    .bind(COMPETITOR_CLASSIFIER_VERSION,now,runId).run();
  const state=await classificationState(env,runId);
  if (state.planned) await env.SCAN_QUEUE.send({kind:"classify-competitors",runId});
  return {candidateCount:state.total,pendingCount:state.planned+state.queued+state.running,failedCount:state.failed,enqueuedCount:state.planned};
}

export async function dispatchCompetitorClassifications(env: Env, runId: string): Promise<void> {
  const planned=await env.DB.prepare(`SELECT cc.package_name FROM competitor_classifications cc
    JOIN competitors c ON c.run_id=cc.run_id AND c.package_name=cc.package_name
    WHERE cc.run_id=? AND cc.status='planned' ORDER BY c.best_rank,c.occurrence_count DESC,cc.package_name LIMIT 100`)
    .bind(runId).all<{package_name:string}>();
  if (!planned.results.length) return;
  await env.SCAN_QUEUE.sendBatch(planned.results.map((row)=>({body:{kind:"enrich-competitor" as const,runId,packageName:row.package_name}})));
  await env.DB.prepare("UPDATE competitor_classifications SET status='queued' WHERE run_id=? AND status='planned' AND package_name IN (SELECT value FROM json_each(?))")
    .bind(runId,JSON.stringify(planned.results.map((r)=>r.package_name))).run();
  if (planned.results.length===100) await env.SCAN_QUEUE.send({kind:"classify-competitors",runId});
}

async function queryEvidence(env: Env, runId: string, packageName: string): Promise<CompetitorQueryEvidence[]> {
  const rows = await env.DB.prepare(
    `SELECT sp.position, rq.query, rq.lane, rq.product_area, rq.tags_json
     FROM search_positions sp
     JOIN run_queries rq ON rq.run_id = sp.run_id AND rq.query_id = sp.query_id
     WHERE sp.run_id = ? AND sp.package_name = ?`,
  ).bind(runId, packageName).all<{
    position: number;
    query: string;
    lane: string;
    product_area: string;
    tags_json: string;
  }>();
  return rows.results.map((row) => ({
    position: row.position,
    query: row.query,
    lane: row.lane,
    productArea: row.product_area,
    tags: JSON.parse(row.tags_json) as Record<string, string>,
  }));
}

export async function enrichCompetitor(
  env: Env,
  runId: string,
  packageName: string,
  attempts: number,
): Promise<void> {
  const current = await env.DB.prepare(
    "SELECT status FROM competitor_classifications WHERE run_id = ? AND package_name = ?",
  ).bind(runId, packageName).first<{ status: string }>();
  if (!current) throw new PermanentCompetitorError("Competitor candidate is not registered.", "competitor-candidate-missing");
  if (current.status === "complete" || current.status === "failed") return;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE competitor_classifications SET status = 'running', updated_at = ? WHERE run_id = ? AND package_name = ?",
  ).bind(now, runId, packageName).run();

  const enriched = await refreshPackage(env, packageName, attempts, runId);
  await persistPackageClassification(env, runId, enriched);
}

async function persistPackageClassification(env: Env, runId: string, enriched: IntelligencePackage): Promise<void> {
  const packageName = enriched.package_name;
  const metadata: CompetitorMetadata = {packageName,version:enriched.published_version,description:enriched.description,topics:enriched.topics};
  const result: CompetitorClassification = {relationship:enriched.relationship,capabilityCategory:enriched.capability_category,
    rationale:enriched.rationale,matchedTerms:enriched.actions,capabilities:enriched.capabilities};
  const metrics = relevantCompetitorMetrics(await queryEvidence(env, runId, packageName), result);
  const capturedAt = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE competitor_classifications SET
      status = 'complete', relationship = ?, capability_category = ?, classifier_version = ?,
      published_version = ?, published_description = ?, published_topics_json = ?, metadata_captured_at = ?,
      rationale = ?, matched_terms_json = ?, relevant_occurrence_count = ?, relevant_best_rank = ?,
      relevant_median_rank = ?, error_code = NULL, error_message = NULL, updated_at = ?
     WHERE run_id = ? AND package_name = ?`,
  ).bind(
    result.relationship,
    result.capabilityCategory,
    COMPETITOR_CLASSIFIER_VERSION,
    metadata.version,
    metadata.description || null,
    JSON.stringify(metadata.topics),
    enriched.metadata_captured_at,
    result.rationale,
    JSON.stringify(result.matchedTerms),
    metrics.occurrenceCount,
    metrics.bestRank,
    metrics.medianRank,
    capturedAt,
    runId,
    packageName,
  ).run();
}

/** Derived comparisons follow changed evidence; immutable report artifacts are untouched. */
export async function updatePackageComparisons(env: Env, enriched: IntelligencePackage): Promise<void> {
  const reports = await env.DB.prepare("SELECT run_id FROM competitor_classifications WHERE package_name=? AND status IN ('complete','failed')")
    .bind(enriched.package_name).all<{run_id:string}>();
  for (const report of reports.results) await persistPackageClassification(env, report.run_id, enriched);
}

export async function recordCompetitorRetry(
  env: Env,
  runId: string,
  packageName: string,
  error: RetryableCompetitorError,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE competitor_classifications SET status = 'queued', retry_count = retry_count + 1,
      error_code = ?, error_message = ?, updated_at = ? WHERE run_id = ? AND package_name = ? AND status != 'complete'`,
  ).bind(error.code, error.message.slice(0, 1000), new Date().toISOString(), runId, packageName).run();
  await recordDiagnostic(env, {
    runId,
    severity: "warning",
    code: error.code,
    detail: `${packageName}: ${error.message} Retrying after ${error.delaySeconds} seconds.`,
  });
}

export async function markCompetitorFailed(
  env: Env,
  runId: string,
  packageName: string,
  error: { code: string; message: string },
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE competitor_classifications SET status = 'failed', relationship = 'unknown', capability_category = 'other',
      rationale = 'Package metadata was unavailable; no competitor relationship was inferred.',
      relevant_occurrence_count = 0, relevant_best_rank = NULL, relevant_median_rank = NULL,
      error_code = ?, error_message = ?, metadata_captured_at = NULL, updated_at = ?
     WHERE run_id = ? AND package_name = ? AND status != 'complete'`,
  ).bind(error.code, error.message.slice(0, 1000), now, runId, packageName).run();
  await recordDiagnostic(env, { runId, severity: "warning", code: error.code, detail: `${packageName}: ${error.message}` });
}

export async function competitorClassificationsReady(env: Env, runId: string): Promise<boolean> {
  const state = await classificationState(env, runId);
  return state.total === 0 || state.planned + state.queued + state.running === 0;
}

export async function completeCompetitorEnrichment(
  env: Env,
  runId: string,
): Promise<{ ready: boolean; materialized: boolean }> {
  const ready = await competitorClassificationsReady(env, runId);
  const run = await env.DB.prepare(
    "SELECT report_materialized FROM runs WHERE id = ?",
  ).bind(runId).first<{ report_materialized: number }>();
  const materialized = Boolean(run?.report_materialized);
  if (ready && !materialized) {
    await env.SCAN_QUEUE.send({ kind: "finalize-run", runId });
  }
  return { ready, materialized };
}

export async function startCompetitorBackfill(
  env: Env,
  idempotencyKey: string,
  requestedRunId?: string,
): Promise<CompetitorBackfillResult> {
  const existing = await env.DB.prepare(
    "SELECT requested_run_id, status, response_json FROM competitor_backfills WHERE idempotency_key = ?",
  ).bind(idempotencyKey).first<{ requested_run_id: string | null; status: string; response_json: string }>();
  if (existing && existing.requested_run_id !== (requestedRunId ?? null)) {
    throw new PermanentCompetitorError("Idempotency key was already used for a different competitor backfill scope.", "backfill-idempotency-conflict");
  }
  if (existing?.status === "complete") {
    return { ...(JSON.parse(existing.response_json) as CompetitorBackfillResult), already_started: true };
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO competitor_backfills (idempotency_key, requested_run_id, status, response_json, created_at, updated_at)
     VALUES (?, ?, 'running', '{}', ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
  ).bind(idempotencyKey, requestedRunId ?? null, now, now).run();

  const condition = requestedRunId ? "AND r.id = ?" : "";
  const statement = env.DB.prepare(
    `SELECT r.id FROM runs r WHERE r.profile = 'full' AND r.report_materialized = 1 ${condition}
     ORDER BY r.report_date, r.created_at`,
  );
  const runs = requestedRunId
    ? await statement.bind(requestedRunId).all<{ id: string }>()
    : await statement.all<{ id: string }>();
  if (requestedRunId && !runs.results.length) throw new PermanentCompetitorError("Requested run is not a materialized full report.", "backfill-run-unavailable");

  const started: string[] = [];
  const unavailable: string[] = [];
  let enqueuedCount = 0;
  for (const run of runs.results) {
    const competitors = await aggregateCompetitors(env, run.id);
    if (!competitors.length) {
      unavailable.push(run.id);
      continue;
    }
    await upsertCompetitors(env, run.id, competitors);
    const result = await ensureCompetitorClassifications(env, run.id);
    started.push(run.id);
    enqueuedCount += result.enqueuedCount;
  }
  const response: CompetitorBackfillResult = {
    status: "accepted",
    started_runs: started,
    unavailable_runs: unavailable,
    enqueued_count: enqueuedCount,
  };
  await env.DB.prepare(
    "UPDATE competitor_backfills SET status = 'complete', response_json = ?, updated_at = ? WHERE idempotency_key = ?",
  ).bind(JSON.stringify(response), new Date().toISOString(), idempotencyKey).run();
  return response;
}
