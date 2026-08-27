import {
  canonicalizeHistoricalRuns,
  compareQuerySets,
  movementCounts,
  type HistoricalRun,
  type MovementOutcome,
  type MovementQuery,
  type QueryMovement,
  type QuerySetComparison,
} from "../shared/movement.js";

interface VersionSnapshot {
  published_version: string | null;
  repository_version: string | null;
}

interface HistoryFilters {
  profile: "pulse" | "full";
  from: string | null;
  to: string | null;
}

export class HistoryInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function validUtcDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function historyFilters(url: URL): HistoryFilters {
  const profile = url.searchParams.get("profile") ?? "pulse";
  if (profile !== "pulse" && profile !== "full") throw new HistoryInputError("Profile must be pulse or full.");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from && !validUtcDate(from)) throw new HistoryInputError("from must be a valid UTC date in YYYY-MM-DD format.");
  if (to && !validUtcDate(to)) throw new HistoryInputError("to must be a valid UTC date in YYYY-MM-DD format.");
  if (from && to && from > to) throw new HistoryInputError("from must be on or before to.");
  return { profile, from, to };
}

async function historicalRuns(env: Env, filters: HistoryFilters): Promise<ReturnType<typeof canonicalizeHistoricalRuns>> {
  const clauses = ["(profile = ? OR profile = 'legacy-mixed')"];
  const bindings: unknown[] = [filters.profile];
  if (filters.from) { clauses.push("report_date >= ?"); bindings.push(filters.from); }
  if (filters.to) { clauses.push("report_date <= ?"); bindings.push(filters.to); }
  const result = await env.DB.prepare(
    `SELECT id, profile, catalog_version, report_date, requested_depth, effective_depth,
      trigger_source, status, completed_at, created_at, report_materialized
     FROM runs WHERE ${clauses.join(" AND ")}
     ORDER BY report_date ASC, created_at ASC`,
  ).bind(...bindings).all<HistoricalRun>();
  return canonicalizeHistoricalRuns(result.results, filters.profile);
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function queryMaps(env: Env, runs: HistoricalRun[]): Promise<Map<string, MovementQuery[]>> {
  const result = new Map(runs.map((run) => [run.id, [] as MovementQuery[]]));
  for (const batch of chunks(runs.map((run) => run.id), 50)) {
    const placeholders = batch.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT run_id, query_id, query, definition_hash, rank, requested_depth,
        actual_depth, exhausted, status
       FROM run_queries WHERE run_id IN (${placeholders}) ORDER BY run_id, query_id`,
    ).bind(...batch).all<MovementQuery & { run_id: string }>();
    for (const row of rows.results) result.get(row.run_id)?.push(row);
  }
  return result;
}

async function versionMaps(env: Env, runs: HistoricalRun[]): Promise<Map<string, VersionSnapshot>> {
  const result = new Map<string, VersionSnapshot>();
  for (const batch of chunks(runs.map((run) => run.id), 50)) {
    const placeholders = batch.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT run_id, published_version, repository_version
       FROM package_snapshots WHERE run_id IN (${placeholders})`,
    ).bind(...batch).all<VersionSnapshot & { run_id: string }>();
    for (const row of rows.results) result.set(row.run_id, row);
  }
  return result;
}

function report(run: HistoricalRun, version?: VersionSnapshot) {
  return {
    id: run.id,
    profile: run.profile,
    report_date: run.report_date,
    depth: run.effective_depth,
    catalog_version: run.catalog_version,
    trigger_source: run.trigger_source,
    published_version: version?.published_version ?? null,
    repository_version: version?.repository_version ?? null,
  };
}

function transition(
  before: HistoricalRun,
  after: HistoricalRun,
  comparison: QuerySetComparison,
  versions: Map<string, VersionSnapshot>,
) {
  return {
    before: report(before, versions.get(before.id)),
    after: report(after, versions.get(after.id)),
    counts: movementCounts(comparison.movements),
    added: comparison.added.length,
    retired: comparison.retired.length,
    redefined: comparison.redefined.length,
    catalog_changed: before.catalog_version !== after.catalog_version,
  };
}

function compareRuns(before: HistoricalRun, after: HistoricalRun, queries: Map<string, MovementQuery[]>): QuerySetComparison {
  return compareQuerySets(queries.get(before.id) ?? [], queries.get(after.id) ?? []);
}

export async function historySummary(env: Env, url: URL): Promise<Record<string, unknown>> {
  const filters = historyFilters(url);
  const selected = await historicalRuns(env, filters);
  const [queries, versions] = await Promise.all([queryMaps(env, selected.reports), versionMaps(env, selected.reports)]);
  const reports = selected.reports.map((run) => report(run, versions.get(run.id)));
  const timeline = [];
  for (let index = 1; index < selected.reports.length; index += 1) {
    const before = selected.reports[index - 1];
    const after = selected.reports[index];
    timeline.push(transition(before, after, compareRuns(before, after, queries), versions));
  }

  let net: Record<string, unknown> | null = null;
  if (selected.reports.length >= 2) {
    const before = selected.reports[0];
    const after = selected.reports[selected.reports.length - 1];
    const comparison = compareRuns(before, after, queries);
    net = {
      before: report(before, versions.get(before.id)),
      after: report(after, versions.get(after.id)),
      counts: movementCounts(comparison.movements),
      movements: comparison.movements,
      added: comparison.added,
      retired: comparison.retired,
      redefined: comparison.redefined,
    };
  }

  return {
    profile: filters.profile,
    range: {
      from: filters.from,
      to: filters.to,
      first_report_date: reports[0]?.report_date ?? null,
      last_report_date: reports.at(-1)?.report_date ?? null,
      snapshot_count: reports.length,
    },
    reports,
    net,
    timeline,
    excluded_runs: selected.excluded.map((run) => ({
      id: run.id,
      profile: run.profile,
      report_date: run.report_date,
      depth: run.effective_depth,
      status: run.status,
      trigger_source: run.trigger_source,
      reason: run.exclusion_reason,
    })),
    interpretation: "Dropped means a worse numeric rank. Lost visibility is separate and appears only when completed depth or result exhaustion proves absence.",
  };
}

const DEFAULT_EVENT_OUTCOMES: MovementOutcome[] = ["improved", "dropped", "found", "lost_visibility"];
const EVENT_OUTCOMES = new Set<MovementOutcome>([
  "improved", "dropped", "found", "lost_visibility", "unchanged", "not_visible", "withheld",
]);

function eventKey(event: { after: { report_date: string }; before: { report_date: string }; movement: QueryMovement }): string {
  return `${event.after.report_date}\u0000${event.before.report_date}\u0000${event.movement.query_id}\u0000${event.movement.outcome}`;
}

export function encodeHistoryCursor(key: string): string {
  return btoa(key).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeHistoryCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new HistoryInputError("Invalid history cursor.");
  const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(cursor.length / 4) * 4, "=");
  try {
    return atob(base64);
  } catch {
    throw new HistoryInputError("Invalid history cursor.");
  }
}

export function historyPageLimit(raw: string | null): number {
  const value = Number(raw ?? 50);
  if (!Number.isInteger(value) || value < 1) throw new HistoryInputError("limit must be a positive integer.");
  return Math.min(250, value);
}

function requestedOutcomes(url: URL): Set<MovementOutcome> {
  const raw = url.searchParams.get("outcome");
  if (!raw) return new Set(DEFAULT_EVENT_OUTCOMES);
  if (raw === "all") return new Set(EVENT_OUTCOMES);
  const outcomes = raw.split(",").filter(Boolean) as MovementOutcome[];
  if (!outcomes.length || outcomes.some((outcome) => !EVENT_OUTCOMES.has(outcome))) {
    throw new HistoryInputError("outcome contains an unsupported movement class.");
  }
  return new Set(outcomes);
}

export async function historyEvents(env: Env, url: URL): Promise<Record<string, unknown>> {
  const filters = historyFilters(url);
  const outcomes = requestedOutcomes(url);
  const limit = historyPageLimit(url.searchParams.get("limit"));
  const selected = await historicalRuns(env, filters);
  const [queries, versions] = await Promise.all([queryMaps(env, selected.reports), versionMaps(env, selected.reports)]);
  const events: Array<{
    before: ReturnType<typeof report>;
    after: ReturnType<typeof report>;
    movement: QueryMovement;
  }> = [];
  for (let index = 1; index < selected.reports.length; index += 1) {
    const before = selected.reports[index - 1];
    const after = selected.reports[index];
    const comparison = compareRuns(before, after, queries);
    for (const movement of comparison.movements) {
      if (!outcomes.has(movement.outcome)) continue;
      events.push({
        before: report(before, versions.get(before.id)),
        after: report(after, versions.get(after.id)),
        movement,
      });
    }
  }
  events.sort((left, right) =>
    right.after.report_date.localeCompare(left.after.report_date)
      || right.before.report_date.localeCompare(left.before.report_date)
      || left.movement.query.localeCompare(right.movement.query)
      || left.movement.outcome.localeCompare(right.movement.outcome));

  const cursor = url.searchParams.get("cursor");
  let start = 0;
  if (cursor) {
    const key = decodeHistoryCursor(cursor);
    const index = events.findIndex((event) => eventKey(event) === key);
    if (index < 0) throw new HistoryInputError("History cursor does not match this filtered timeline.");
    start = index + 1;
  }
  const page = events.slice(start, start + limit);
  const last = page.at(-1);
  return {
    profile: filters.profile,
    events: page,
    next_cursor: start + page.length < events.length && last ? encodeHistoryCursor(eventKey(last)) : null,
    page_size: page.length,
    total_events: events.length,
  };
}
