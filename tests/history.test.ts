import { describe, expect, it } from "vitest";
import {
  canonicalizeHistoricalRuns,
  canonicalizePackageSnapshots,
  compareQuerySets,
  movementCounts,
  type HistoricalRun,
  type MovementQuery,
} from "../src/shared/movement.js";
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyFilters,
  historyPageLimit,
} from "../src/worker/history.js";
import { parseHistoryView, queryExplorerLink, selectedDateRange, sortMovements } from "../src/dashboard/history-state.js";

function query(query_id: string, rank: number | null, overrides: Partial<MovementQuery> = {}): MovementQuery {
  return {
    query_id,
    query: query_id.replaceAll("-", " "),
    definition_hash: `hash:${query_id}`,
    rank,
    requested_depth: 10,
    actual_depth: 10,
    exhausted: 0,
    status: "complete",
    ...overrides,
  };
}

function run(id: string, report_date: string, overrides: Partial<HistoricalRun> = {}): HistoricalRun {
  return {
    id,
    profile: "pulse",
    catalog_version: "v3-a",
    report_date,
    requested_depth: 10,
    effective_depth: 10,
    trigger_source: "migration",
    status: "complete",
    completed_at: `${report_date}T08:00:00.000Z`,
    created_at: `${report_date}T07:00:00.000Z`,
    report_materialized: 1,
    ...overrides,
  };
}

describe("historical movement classification", () => {
  it("distinguishes numeric drops from proven lost visibility and withheld loss", () => {
    const before = [
      query("improved", 8),
      query("dropped", 2),
      query("found", null),
      query("lost", 4),
      query("withheld", 80, { requested_depth: 100, actual_depth: 100 }),
      query("unchanged", 5),
      query("not-visible", null),
      query("retired", 9),
      query("redefined", 6),
    ];
    const after = [
      query("improved", 3),
      query("dropped", 7),
      query("found", 5),
      query("lost", null),
      query("withheld", null, { actual_depth: 10 }),
      query("unchanged", 5),
      query("not-visible", null),
      query("added", 10),
      query("redefined", 4, { definition_hash: "new-definition" }),
    ];
    const comparison = compareQuerySets(before, after);
    const outcomes = Object.fromEntries(comparison.movements.map((item) => [item.query_id, item]));
    expect(outcomes.improved).toMatchObject({ outcome: "improved", positions_gained: 5, delta: 5 });
    expect(outcomes.dropped).toMatchObject({ outcome: "dropped", positions_lost: 5, delta: -5 });
    expect(outcomes.found.outcome).toBe("found");
    expect(outcomes.lost.outcome).toBe("lost_visibility");
    expect(outcomes.withheld).toMatchObject({ outcome: "withheld", reason: "unproven-loss" });
    expect(outcomes.unchanged.outcome).toBe("unchanged");
    expect(outcomes["not-visible"].outcome).toBe("not_visible");
    expect(comparison.added.map((item) => item.query_id)).toEqual(["added"]);
    expect(comparison.retired.map((item) => item.query_id)).toEqual(["retired"]);
    expect(comparison.redefined.map((item) => item.query_id)).toEqual(["redefined"]);
    expect(movementCounts(comparison.movements)).toMatchObject({
      improved: 1,
      positions_gained: 5,
      dropped: 1,
      positions_lost: 5,
      found: 1,
      lost_visibility: 1,
      withheld: 1,
      unchanged: 1,
      not_visible: 1,
    });
  });

  it("withholds incomplete observations", () => {
    const result = compareQuerySets([query("query", 2)], [query("query", null, { status: "failed" })]);
    expect(result.movements[0]).toMatchObject({ outcome: "withheld", reason: "incomplete-observation" });
  });
});

describe("historical run selection", () => {
  it("prefers live reports per date and excludes incompatible observations", () => {
    const selected = canonicalizeHistoricalRuns([
      run("legacy", "2026-08-27"),
      run("live", "2026-08-27", { trigger_source: "manual", completed_at: "2026-08-27T10:00:00.000Z" }),
      run("incomplete", "2026-08-20", { status: "incomplete", report_materialized: 0 }),
      run("mixed-depth", "2026-08-13", { effective_depth: 7 }),
      run("legacy-mixed", "2026-07-01", { profile: "legacy-mixed", effective_depth: null }),
      run("older", "2026-08-10"),
    ], "pulse");
    expect(selected.reports.map((item) => item.id)).toEqual(["older", "live"]);
    expect(Object.fromEntries(selected.excluded.map((item) => [item.id, item.exclusion_reason]))).toEqual({
      "legacy-mixed": "legacy-mixed",
      "mixed-depth": "mixed-depth",
      incomplete: "incomplete",
      legacy: "duplicate-date",
    });
  });

  it("deduplicates package snapshots per UTC date with live data first", () => {
    const snapshots = canonicalizePackageSnapshots([
      { run_id: "migration", report_date: "2026-08-27", trigger_source: "migration", captured_at: "2026-08-27T20:00:00Z", downloads_30d: 1724 },
      { run_id: "live", report_date: "2026-08-27", trigger_source: "manual", captured_at: "2026-08-27T10:00:00Z", downloads_30d: 1724 },
      { run_id: "older", report_date: "2026-08-10", trigger_source: "migration", captured_at: "2026-08-10T10:00:00Z", downloads_30d: 1493 },
    ]);
    expect(snapshots.map((item) => item.run_id)).toEqual(["older", "live"]);
  });
});

describe("history request and dashboard state", () => {
  it("validates inclusive UTC ranges and profile", () => {
    expect(historyFilters(new URL("https://example.test/api?profile=full&from=2026-08-10&to=2026-08-27"))).toEqual({ profile: "full", from: "2026-08-10", to: "2026-08-27" });
    expect(() => historyFilters(new URL("https://example.test/api?from=2026-02-30"))).toThrow(/valid UTC date/);
    expect(() => historyFilters(new URL("https://example.test/api?from=2026-08-27&to=2026-08-10"))).toThrow(/on or before/);
  });

  it("calculates presets relative to the latest snapshot and preserves custom ranges", () => {
    const defaults = parseHistoryView(new URLSearchParams());
    expect(defaults).toMatchObject({ profile: "pulse", range: "all" });
    expect(parseHistoryView(new URLSearchParams("profile=full&range=custom&from=2026-07-01&to=2026-08-27"))).toEqual({ profile: "full", range: "custom", from: "2026-07-01", to: "2026-08-27" });
    expect(selectedDateRange({ ...defaults, range: "30d" }, "2026-08-27")).toEqual({ from: "2026-07-29", to: "2026-08-27", error: null });
    expect(selectedDateRange({ profile: "pulse", range: "custom", from: "2026-07-01", to: "2026-08-27" }, "2026-08-27")).toEqual({ from: "2026-07-01", to: "2026-08-27", error: null });
  });

  it("uses bounded opaque cursors and deterministic movement sorting", () => {
    const key = "2026-08-27\u00002026-08-10\u0000query-id\u0000dropped";
    expect(decodeHistoryCursor(encodeHistoryCursor(key))).toBe(key);
    expect(() => decodeHistoryCursor("not*a*cursor")).toThrow(/Invalid history cursor/);
    expect(historyPageLimit(null)).toBe(50);
    expect(historyPageLimit("999")).toBe(250);
    expect(() => historyPageLimit("0")).toThrow(/positive integer/);
    const movements = compareQuerySets([query("a", 2), query("b", 8)], [query("a", 7), query("b", 3)]).movements;
    expect(sortMovements(movements, "change", true).map((item) => item.query_id)).toEqual(["b", "a"]);
    expect(queryExplorerLink("pulse", "run id", "query/id")).toBe("/queries?profile=pulse&run=run+id&query=query%2Fid");
  });
});
