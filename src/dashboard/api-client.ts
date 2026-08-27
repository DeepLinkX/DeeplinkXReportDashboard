import { useEffect, useState } from "react";
import type { MovementCounts, QueryMovement, RedefinedQuery, CatalogChange } from "../shared/movement.js";

export interface Run {
  id: string;
  profile: "pulse" | "full" | "legacy-mixed";
  catalog_version: string;
  report_date: string;
  requested_depth: number;
  effective_depth: number | null;
  status: string;
  query_count: number;
  completed_count: number;
  failed_count: number;
  created_at: string;
  completed_at: string | null;
  report_materialized: number;
  coverage?: Coverage;
}

export interface Coverage { total: number; top_1: number; top_3: number; top_10: number; }

export interface QueryResult {
  query_id: string;
  query: string;
  lane: string;
  product_area: string;
  expression_type: string;
  product_fit: string;
  tags: Record<string, string>;
  sources: Array<{ type: string; location: string; derivation: string }>;
  definition_hash: string;
  requested_depth: number;
  actual_depth: number;
  rank: number | null;
  pages_scanned: number;
  exhausted: number;
  status: string;
  retry_count: number;
  packages: string[];
  error_code: string | null;
}

export interface PackageSnapshot {
  published_version: string | null;
  published_at: string | null;
  repository_version: string | null;
  points: number | null;
  max_points: number | null;
  likes: number | null;
  downloads_30d: number | null;
  captured_at: string;
  run_id: string;
  profile?: string;
  report_date?: string;
}

export interface Summary {
  service: string;
  latest: { pulse: Run | null; full: Run | null };
  active_run: Run | null;
  package_snapshot: PackageSnapshot | null;
  recommendations: Array<{
    run_id: string;
    query_id: string;
    class: string;
    priority: number;
    rationale: string;
    query: string;
    rank: number | null;
    requested_depth: number;
  }>;
  catalog_sync: { status: string; catalog_version: string; warning?: string; updated_at: string } | null;
  storage: { retain_raw: boolean; pause_full: boolean; capacity_ratio: number; warning?: string };
  interpretation: string;
}

export interface HistoryReport {
  id: string;
  profile: "pulse" | "full";
  report_date: string;
  depth: number;
  catalog_version: string;
  trigger_source: string;
  published_version: string | null;
  repository_version: string | null;
}

export interface HistoryTransition {
  before: HistoryReport;
  after: HistoryReport;
  counts: MovementCounts;
  added: number;
  retired: number;
  redefined: number;
  catalog_changed: boolean;
}

export interface HistorySummary {
  profile: "pulse" | "full";
  range: {
    from: string | null;
    to: string | null;
    first_report_date: string | null;
    last_report_date: string | null;
    snapshot_count: number;
  };
  reports: HistoryReport[];
  net: null | {
    before: HistoryReport;
    after: HistoryReport;
    counts: MovementCounts;
    movements: QueryMovement[];
    added: CatalogChange[];
    retired: CatalogChange[];
    redefined: RedefinedQuery[];
  };
  timeline: HistoryTransition[];
  excluded_runs: Array<{
    id: string;
    profile: string;
    report_date: string;
    depth: number | null;
    status: string;
    trigger_source: string;
    reason: string;
  }>;
  interpretation: string;
}

export interface HistoryEvent {
  before: HistoryReport;
  after: HistoryReport;
  movement: QueryMovement;
}

export interface HistoryEventsPage {
  profile: "pulse" | "full";
  events: HistoryEvent[];
  next_cursor: string | null;
  page_size: number;
  total_events: number;
}

interface ApiState<T> { data: T | null; error: string | null; loading: boolean; }

export function useApi<T>(path: string | null): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ data: null, error: null, loading: Boolean(path) });
  useEffect(() => {
    if (!path) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    fetch(path, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        const value = await response.json() as T & { error?: string };
        if (!response.ok) throw new Error(value.error ?? `Request failed with HTTP ${response.status}.`);
        return value;
      })
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error: unknown) => {
        if ((error as Error).name !== "AbortError") setState({ data: null, error: (error as Error).message, loading: false });
      });
    return () => controller.abort();
  }, [path]);
  return state;
}

export function rankText(query: Pick<QueryResult, "rank" | "status" | "exhausted" | "actual_depth" | "requested_depth">): string {
  if (query.status === "failed") return "Incomplete";
  if (query.rank !== null) return `#${query.rank}`;
  if (query.exhausted) return `Not found · exhausted at ${query.actual_depth}`;
  return `Not found in top ${query.requested_depth}`;
}

export function formatDate(value?: string | null): string {
  if (!value) return "Not captured";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(value));
}

export function number(value?: number | null): string {
  return value === null || value === undefined ? "—" : new Intl.NumberFormat().format(value);
}
