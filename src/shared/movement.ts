export type MovementOutcome =
  | "improved"
  | "dropped"
  | "found"
  | "lost_visibility"
  | "unchanged"
  | "not_visible"
  | "withheld";

export interface MovementQuery {
  query_id: string;
  query: string;
  definition_hash: string;
  rank: number | null;
  requested_depth: number;
  actual_depth: number;
  exhausted: number | boolean;
  status: string;
}

export interface QueryMovement {
  query_id: string;
  query: string;
  before_rank: number | null;
  after_rank: number | null;
  delta: number | null;
  positions_gained: number;
  positions_lost: number;
  outcome: MovementOutcome;
  reason: "rank-improved" | "rank-dropped" | "newly-visible" | "proven-absence" | "same-rank" | "absent-both" | "unproven-loss" | "incomplete-observation";
  before_actual_depth: number;
  after_actual_depth: number;
}

export interface CatalogChange {
  query_id: string;
  query: string;
}

export interface RedefinedQuery {
  query_id: string;
  before: string;
  after: string;
  before_definition_hash: string;
  after_definition_hash: string;
}

export interface QuerySetComparison {
  movements: QueryMovement[];
  added: CatalogChange[];
  retired: CatalogChange[];
  redefined: RedefinedQuery[];
}

export interface MovementCounts {
  improved: number;
  positions_gained: number;
  dropped: number;
  positions_lost: number;
  found: number;
  lost_visibility: number;
  unchanged: number;
  not_visible: number;
  withheld: number;
}

function movement(
  previous: MovementQuery,
  current: MovementQuery,
  outcome: MovementOutcome,
  reason: QueryMovement["reason"],
  delta: number | null = null,
): QueryMovement {
  return {
    query_id: previous.query_id,
    query: current.query,
    before_rank: previous.rank,
    after_rank: current.rank,
    delta,
    positions_gained: delta !== null && delta > 0 ? delta : 0,
    positions_lost: delta !== null && delta < 0 ? -delta : 0,
    outcome,
    reason,
    before_actual_depth: previous.actual_depth,
    after_actual_depth: current.actual_depth,
  };
}

export function classifyMovement(previous: MovementQuery, current: MovementQuery): QueryMovement {
  if (previous.status !== "complete" || current.status !== "complete") {
    return movement(previous, current, "withheld", "incomplete-observation");
  }
  if (previous.rank !== null && current.rank !== null) {
    const delta = previous.rank - current.rank;
    if (delta > 0) return movement(previous, current, "improved", "rank-improved", delta);
    if (delta < 0) return movement(previous, current, "dropped", "rank-dropped", delta);
    return movement(previous, current, "unchanged", "same-rank", 0);
  }
  if (previous.rank === null && current.rank !== null) {
    return movement(previous, current, "found", "newly-visible");
  }
  if (previous.rank !== null && current.rank === null) {
    const proven = Boolean(current.exhausted) || current.actual_depth >= previous.rank;
    return proven
      ? movement(previous, current, "lost_visibility", "proven-absence")
      : movement(previous, current, "withheld", "unproven-loss");
  }
  return movement(previous, current, "not_visible", "absent-both");
}

export function compareQuerySets(before: MovementQuery[], after: MovementQuery[]): QuerySetComparison {
  const beforeMap = new Map(before.map((query) => [query.query_id, query]));
  const afterMap = new Map(after.map((query) => [query.query_id, query]));
  const added = after
    .filter((query) => !beforeMap.has(query.query_id))
    .map((query) => ({ query_id: query.query_id, query: query.query }));
  const retired = before
    .filter((query) => !afterMap.has(query.query_id))
    .map((query) => ({ query_id: query.query_id, query: query.query }));
  const redefined: RedefinedQuery[] = [];
  const movements: QueryMovement[] = [];

  for (const previous of before) {
    const current = afterMap.get(previous.query_id);
    if (!current) continue;
    if (previous.definition_hash !== current.definition_hash) {
      redefined.push({
        query_id: previous.query_id,
        before: previous.query,
        after: current.query,
        before_definition_hash: previous.definition_hash,
        after_definition_hash: current.definition_hash,
      });
      continue;
    }
    movements.push(classifyMovement(previous, current));
  }

  return {
    movements: movements.sort((left, right) => left.query.localeCompare(right.query)),
    added: added.sort((left, right) => left.query.localeCompare(right.query)),
    retired: retired.sort((left, right) => left.query.localeCompare(right.query)),
    redefined: redefined.sort((left, right) => left.before.localeCompare(right.before)),
  };
}

export function movementCounts(movements: QueryMovement[]): MovementCounts {
  const counts: MovementCounts = {
    improved: 0,
    positions_gained: 0,
    dropped: 0,
    positions_lost: 0,
    found: 0,
    lost_visibility: 0,
    unchanged: 0,
    not_visible: 0,
    withheld: 0,
  };
  for (const item of movements) {
    counts[item.outcome] += 1;
    counts.positions_gained += item.positions_gained;
    counts.positions_lost += item.positions_lost;
  }
  return counts;
}

export interface HistoricalRun {
  id: string;
  profile: string;
  catalog_version: string;
  report_date: string;
  requested_depth: number;
  effective_depth: number | null;
  trigger_source: string;
  status: string;
  completed_at: string | null;
  created_at: string;
  report_materialized: number | boolean;
}

export interface ExcludedHistoricalRun extends HistoricalRun {
  exclusion_reason: "legacy-mixed" | "incomplete" | "mixed-depth" | "duplicate-date";
}

export function canonicalizeHistoricalRuns(
  rows: HistoricalRun[],
  profile: "pulse" | "full",
): { reports: HistoricalRun[]; excluded: ExcludedHistoricalRun[] } {
  const expectedDepth = profile === "pulse" ? 10 : 100;
  const candidates: HistoricalRun[] = [];
  const excluded: ExcludedHistoricalRun[] = [];

  for (const row of rows) {
    if (row.profile === "legacy-mixed") {
      excluded.push({ ...row, exclusion_reason: "legacy-mixed" });
    } else if (row.profile !== profile) {
      continue;
    } else if (row.status !== "complete" || !row.report_materialized) {
      excluded.push({ ...row, exclusion_reason: "incomplete" });
    } else if (row.effective_depth !== expectedDepth) {
      excluded.push({ ...row, exclusion_reason: "mixed-depth" });
    } else {
      candidates.push(row);
    }
  }

  const byDate = new Map<string, HistoricalRun[]>();
  for (const row of candidates) byDate.set(row.report_date, [...(byDate.get(row.report_date) ?? []), row]);
  const reports: HistoricalRun[] = [];
  for (const sameDate of byDate.values()) {
    sameDate.sort((left, right) => {
      const sourceDifference = Number(left.trigger_source === "migration") - Number(right.trigger_source === "migration");
      if (sourceDifference) return sourceDifference;
      const completionDifference = (right.completed_at ?? right.created_at).localeCompare(left.completed_at ?? left.created_at);
      return completionDifference || right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id);
    });
    reports.push(sameDate[0]);
    excluded.push(...sameDate.slice(1).map((row) => ({ ...row, exclusion_reason: "duplicate-date" as const })));
  }

  reports.sort((left, right) => left.report_date.localeCompare(right.report_date) || left.created_at.localeCompare(right.created_at));
  excluded.sort((left, right) => left.report_date.localeCompare(right.report_date) || left.id.localeCompare(right.id));
  return { reports, excluded };
}

export interface DatedPackageSnapshot {
  run_id: string;
  report_date: string;
  trigger_source: string;
  captured_at: string;
}

export function canonicalizePackageSnapshots<T extends DatedPackageSnapshot>(rows: T[]): T[] {
  const byDate = new Map<string, T[]>();
  for (const row of rows) byDate.set(row.report_date, [...(byDate.get(row.report_date) ?? []), row]);
  return [...byDate.values()].map((sameDate) => [...sameDate].sort((left, right) => {
    const sourceDifference = Number(left.trigger_source === "migration") - Number(right.trigger_source === "migration");
    return sourceDifference || right.captured_at.localeCompare(left.captured_at) || right.run_id.localeCompare(left.run_id);
  })[0]).sort((left, right) => left.report_date.localeCompare(right.report_date));
}
