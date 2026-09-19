import type { RunQueryRecord, SearchPayload } from "../shared/types.js";
import { enqueueFinalizerIfReady } from "./run-service.js";
import { recordDiagnostic, storeRawBody } from "./retention.js";
import { beforePubdevRequest, recordPubdevThrottle } from "./pubdev.js";

const PAGE_SIZE = 10;
const POSITION_BATCH = 75;

export class RetryableScanError extends Error {
  constructor(message: string, readonly delaySeconds: number, readonly code: string) {
    super(message);
    this.name = "RetryableScanError";
  }
}

export function retryDelay(response: Response | null, attempts: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(43_200, Math.ceil(seconds));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(43_200, Math.max(1, Math.ceil((date - Date.now()) / 1000)));
  }
  const base = Math.min(3_600, 10 * 2 ** Math.min(attempts, 9));
  return Math.max(1, Math.round(base * (0.8 + Math.random() * 0.4)));
}

function groups<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

async function checkpoint(
  env: Env,
  row: RunQueryRecord,
  packages: string[],
  input: { nextPage: number; pagesScanned: number; exhausted: boolean; status?: "running" | "complete" },
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE run_queries SET packages_json = ?, next_page = ?, pages_scanned = ?,
      actual_depth = ?, exhausted = ?, status = ?, updated_at = ?
     WHERE run_id = ? AND query_id = ?`,
  ).bind(
    JSON.stringify(packages),
    input.nextPage,
    input.pagesScanned,
    packages.length,
    input.exhausted ? 1 : 0,
    input.status ?? "running",
    now,
    row.run_id,
    row.query_id,
  ).run();
}

async function fetchSearchPage(
  env: Env,
  row: RunQueryRecord,
  page: number,
  attempts: number,
): Promise<string[]> {
  const url = new URL("https://pub.dev/api/search");
  url.searchParams.set("q", row.query);
  url.searchParams.set("page", String(page));
  await beforePubdevRequest(env);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "deeplinkx-visibility/1.0" },
    });
  } catch (error) {
    throw new RetryableScanError(
      `Network failure: ${error instanceof Error ? error.message : String(error)}`,
      retryDelay(null, attempts),
      "network-error",
    );
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 512_000) throw new Error(`Search page ${page} exceeded the 512 KB limit.`);
  const body = await response.text();
  await storeRawBody(env, {
    runId: row.run_id,
    queryId: row.query_id,
    purpose: `search-page-${page}`,
    sourceUrl: url.toString(),
    response,
    body,
  });
  if (response.status === 429 || response.status >= 500) {
    if (response.status === 429) await recordPubdevThrottle(env,retryDelay(response,attempts),response);
    throw new RetryableScanError(
      `pub.dev returned HTTP ${response.status} for page ${page}.`,
      retryDelay(response, attempts),
      response.status === 429 ? "rate-limited" : "upstream-error",
    );
  }
  if (!response.ok) throw new Error(`pub.dev returned permanent HTTP ${response.status} for page ${page}.`);
  let payload: SearchPayload;
  try {
    payload = JSON.parse(body) as SearchPayload;
  } catch {
    throw new RetryableScanError(`pub.dev returned invalid JSON for page ${page}.`, retryDelay(response, attempts), "invalid-json");
  }
  if (!Array.isArray(payload.packages)) {
    throw new RetryableScanError(`pub.dev search payload has no packages array for page ${page}.`, retryDelay(response, attempts), "invalid-payload");
  }
  return payload.packages
    .map((item) => typeof item?.package === "string" ? item.package.trim() : "")
    .filter(Boolean);
}

export async function scanQuery(env: Env, runId: string, queryId: string, attempts: number): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM run_queries WHERE run_id = ? AND query_id = ?",
  ).bind(runId, queryId).first<RunQueryRecord>();
  if (!row) throw new Error(`Unknown queued query ${runId}/${queryId}.`);
  if (row.status === "complete") return;
  if (row.status === "failed") throw new Error(`Query ${queryId} is already marked failed.`);

  const packages = JSON.parse(row.packages_json) as string[];
  const maximumPages = Math.max(1, Math.ceil(row.requested_depth / PAGE_SIZE));
  let page = Math.max(1, row.next_page);
  let pagesScanned = row.pages_scanned;
  let exhausted = Boolean(row.exhausted);
  await env.DB.prepare(
    `UPDATE run_queries SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE run_id = ? AND query_id = ?`,
  ).bind(new Date().toISOString(), new Date().toISOString(), runId, queryId).run();

  while (!exhausted && page <= maximumPages) {
    const pagePackages = await fetchSearchPage(env, row, page, attempts);
    const before = packages.length;
    for (const packageName of pagePackages) {
      if (!packages.includes(packageName) && packages.length < row.requested_depth) packages.push(packageName);
    }
    pagesScanned += 1;
    exhausted = pagePackages.length < PAGE_SIZE || packages.length === before;
    page += 1;
    await checkpoint(env, row, packages, { nextPage: page, pagesScanned, exhausted });
  }

  const rankIndex = packages.indexOf(env.PACKAGE_NAME);
  const rank = rankIndex < 0 ? null : rankIndex + 1;
  const now = new Date().toISOString();
  const positionStatements = packages.map((packageName, index) => env.DB.prepare(
    `INSERT INTO search_positions (run_id, query_id, package_name, position, page)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id, query_id, package_name) DO UPDATE SET
       position = excluded.position, page = excluded.page`,
  ).bind(runId, queryId, packageName, index + 1, Math.floor(index / PAGE_SIZE) + 1));
  for (const group of groups(positionStatements, POSITION_BATCH)) await env.DB.batch(group);
  await env.DB.prepare(
    `UPDATE run_queries SET rank = ?, actual_depth = ?, exhausted = ?, status = 'complete',
      completed_at = ?, updated_at = ?, error_code = NULL, error_message = NULL
     WHERE run_id = ? AND query_id = ?`,
  ).bind(rank, packages.length, exhausted ? 1 : 0, now, now, runId, queryId).run();
  await enqueueFinalizerIfReady(env, runId);
}

export async function recordRetry(
  env: Env,
  runId: string,
  queryId: string,
  error: RetryableScanError,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE run_queries SET retry_count = retry_count + 1, error_code = ?, error_message = ?, updated_at = ?
     WHERE run_id = ? AND query_id = ? AND status != 'complete'`,
  ).bind(error.code, error.message.slice(0, 1000), new Date().toISOString(), runId, queryId).run();
  await recordDiagnostic(env, {
    runId,
    queryId,
    severity: "warning",
    code: error.code,
    detail: `${error.message} Retrying after ${error.delaySeconds} seconds.`,
  });
}
