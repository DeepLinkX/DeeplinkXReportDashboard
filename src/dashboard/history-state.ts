import type { MovementOutcome, QueryMovement } from "../shared/movement.js";

export type HistoryProfile = "pulse" | "full";
export type HistoryRange = "30d" | "90d" | "1y" | "all" | "custom";
export type MovementFilter = "all" | Extract<MovementOutcome, "improved" | "dropped" | "found" | "lost_visibility">;
export type MovementSort = "query" | "before" | "after" | "change";

export interface HistoryViewState {
  profile: HistoryProfile;
  range: HistoryRange;
  from: string;
  to: string;
}

export function isUtcDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseHistoryView(params: URLSearchParams): HistoryViewState {
  const profile = params.get("profile") === "full" ? "full" : "pulse";
  const requestedRange = params.get("range");
  const range: HistoryRange = requestedRange && ["30d", "90d", "1y", "all", "custom"].includes(requestedRange)
    ? requestedRange as HistoryRange
    : "all";
  return { profile, range, from: params.get("from") ?? "", to: params.get("to") ?? "" };
}

function subtractDays(value: string, count: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - count);
  return date.toISOString().slice(0, 10);
}

export function selectedDateRange(
  state: HistoryViewState,
  latestDate: string | null,
): { from: string | null; to: string | null; error: string | null } {
  if (state.range === "all") return { from: null, to: null, error: null };
  if (state.range === "custom") {
    if (!isUtcDate(state.from) || !isUtcDate(state.to)) {
      return { from: null, to: null, error: "Choose valid start and end dates in UTC." };
    }
    if (state.from > state.to) return { from: null, to: null, error: "The start date must be on or before the end date." };
    return { from: state.from, to: state.to, error: null };
  }
  if (!latestDate) return { from: null, to: null, error: null };
  if (state.range === "30d") return { from: subtractDays(latestDate, 29), to: latestDate, error: null };
  if (state.range === "90d") return { from: subtractDays(latestDate, 89), to: latestDate, error: null };
  const oneYearEarlier = new Date(`${latestDate}T00:00:00.000Z`);
  oneYearEarlier.setUTCFullYear(oneYearEarlier.getUTCFullYear() - 1);
  oneYearEarlier.setUTCDate(oneYearEarlier.getUTCDate() + 1);
  return { from: oneYearEarlier.toISOString().slice(0, 10), to: latestDate, error: null };
}

export function sortMovements(movements: QueryMovement[], sort: MovementSort, descending: boolean): QueryMovement[] {
  const direction = descending ? -1 : 1;
  const rankValue = (value: number | null) => value ?? Number.MAX_SAFE_INTEGER;
  return [...movements].sort((left, right) => {
    let difference = 0;
    if (sort === "query") difference = left.query.localeCompare(right.query);
    if (sort === "before") difference = rankValue(left.before_rank) - rankValue(right.before_rank);
    if (sort === "after") difference = rankValue(left.after_rank) - rankValue(right.after_rank);
    if (sort === "change") difference = (left.delta ?? 0) - (right.delta ?? 0);
    return difference * direction || left.query.localeCompare(right.query);
  });
}

export function queryExplorerLink(profile: HistoryProfile, runId: string, queryId: string): string {
  const params = new URLSearchParams({ profile, run: runId, query: queryId });
  return `/queries?${params.toString()}`;
}
