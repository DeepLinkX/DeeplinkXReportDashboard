import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  RetryableCompetitorError,
  competitorClassificationSummary,
  markCompetitorFailed,
  recordCompetitorRetry,
  startCompetitorBackfill,
  dispatchCompetitorClassifications,
} from "../src/worker/competitors.js";

const catalogVersion = "competitor-test-catalog";

async function insertRun(runId: string, withCompetitors: boolean): Promise<void> {
  const now = "2026-09-02T00:00:00.000Z";
  await env.DB.prepare(
    `INSERT INTO runs (
      id, profile, catalog_version, report_date, requested_depth, effective_depth,
      trigger_source, idempotency_key, status, query_count, completed_count,
      failed_count, completed_at, created_at, updated_at, report_materialized
    ) VALUES (?, 'full', ?, '2026-09-02', 100, 100, 'migration', ?, 'complete', 1, 1, 0, ?, ?, ?, 1)`,
  ).bind(runId, catalogVersion, `test:${runId}`, now, now, now).run();
  await env.DB.prepare(
    `INSERT INTO run_queries (
      run_id, query_id, query, lane, product_area, expression_type, product_fit,
      tags_json, sources_json, definition_hash, requested_depth, actual_depth,
      pages_scanned, next_page, exhausted, status, packages_json, completed_at, updated_at
    ) VALUES (?, 'q-map', 'map launcher', 'compact-core', 'maps-navigation', 'raw', 'high',
      '{}', '[]', 'hash', 100, 2, 1, 2, 1, 'complete', ?, ?, ?)`,
  ).bind(runId, withCompetitors ? '["deeplink_x","map_launcher","iconify_flutter_plus"]' : "[]", now, now).run();
  if (!withCompetitors) return;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO search_positions (run_id, query_id, package_name, position, page) VALUES (?, 'q-map', 'deeplink_x', 1, 1)",
    ).bind(runId),
    env.DB.prepare(
      "INSERT INTO search_positions (run_id, query_id, package_name, position, page) VALUES (?, 'q-map', 'map_launcher', 2, 1)",
    ).bind(runId),
    env.DB.prepare(
      "INSERT INTO search_positions (run_id, query_id, package_name, position, page) VALUES (?, 'q-map', 'iconify_flutter_plus', 3, 1)",
    ).bind(runId),
    env.DB.prepare(
      "INSERT INTO competitors (run_id, package_name, occurrence_count, best_rank, median_rank, category) VALUES (?, 'map_launcher', 1, 2, 2, 'map/navigation launcher')",
    ).bind(runId),
    env.DB.prepare(
      "INSERT INTO competitors (run_id, package_name, occurrence_count, best_rank, median_rank, category) VALUES (?, 'iconify_flutter_plus', 1, 3, 3, 'map/navigation launcher')",
    ).bind(runId),
  ]);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(
    `INSERT INTO catalogs (
      catalog_version, schema_version, catalog_revision, source_commit, source_url,
      content_hash, content_json, pulse_count, full_count, activated_at, created_at, is_active
    ) VALUES (?, 3, 'test', 'commit', 'https://example.test/source', 'hash', '{}', 0, 1, ?, ?, 1)`,
  ).bind(catalogVersion, "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z").run();
  await insertRun("classified-run", true);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO competitor_classifications (
        run_id, package_name, status, relationship, capability_category, classifier_version,
        package_url, rationale, relevant_occurrence_count, relevant_best_rank,
        relevant_median_rank, updated_at
      ) VALUES ('classified-run', 'map_launcher', 'complete', 'direct', 'map/navigation launcher',
        'capabilities-v2.2', 'https://pub.dev/packages/map_launcher', 'Launches installed maps.', 1, 2, 2, ?)`,
    ).bind("2026-09-02T00:00:00.000Z"),
    env.DB.prepare(
      `INSERT INTO competitor_classifications (
        run_id, package_name, status, relationship, capability_category, classifier_version,
        package_url, rationale, relevant_occurrence_count, updated_at
      ) VALUES ('classified-run', 'iconify_flutter_plus', 'complete', 'noise', 'other',
        'capabilities-v2.2', 'https://pub.dev/packages/iconify_flutter_plus', 'Icon package.', 0, ?)`,
    ).bind("2026-09-02T00:00:00.000Z"),
  ]);
  await insertRun("legacy-without-positions", false);
});

describe("competitor classification runtime", () => {
  it("extends the public payload and filters relationships without exposing noise by mistake", async () => {
    const unfiltered = await SELF.fetch("https://visibility.example/api/v1/runs/classified-run/competitors");
    const unfilteredPayload = await unfiltered.json() as { competitors: Array<Record<string, unknown>> };
    expect(unfilteredPayload.competitors).toHaveLength(2);
    expect(unfilteredPayload.competitors[0]).toEqual(expect.objectContaining({
      package_name: "map_launcher",
      occurrence_count: 1,
      best_rank: 2,
      median_rank: 2,
      category: "map/navigation launcher",
    }));

    const response = await SELF.fetch("https://visibility.example/api/v1/runs/classified-run/competitors?relationship=direct");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const payload = await response.json() as {
      competitors: Array<{ package_name: string; relationship: string; occurrence_count: number }>;
      classification: { status: string; relationship_counts: Record<string, number> };
    };
    expect(payload.competitors).toEqual([
      expect.objectContaining({ package_name: "map_launcher", relationship: "direct", occurrence_count: 1 }),
    ]);
    expect(payload.classification).toMatchObject({
      status: "complete",
      relationship_counts: { direct: 1, adjacent: 0, noise: 1, unknown: 0 },
    });

    const invalid = await SELF.fetch("https://visibility.example/api/v1/runs/classified-run/competitors?relationship=invalid");
    expect(invalid.status).toBe(400);
  });

  it("reports migrated runs without package positions as unavailable", async () => {
    const response = await SELF.fetch("https://visibility.example/api/v1/runs/legacy-without-positions/competitors");
    const payload = await response.json() as { competitors: unknown[]; classification: { status: string; reason: string } };
    expect(payload.competitors).toEqual([]);
    expect(payload.classification.status).toBe("unavailable");
    expect(payload.classification.reason).toMatch(/cannot be reconstructed honestly/);
  });

  it("keeps backfills idempotent when a run is already classified", async () => {
    const first = await startCompetitorBackfill(env, "backfill-test", "classified-run");
    const repeated = await startCompetitorBackfill(env, "backfill-test", "classified-run");
    expect(first).toMatchObject({ status: "accepted", started_runs: ["classified-run"], enqueued_count: 0 });
    expect(repeated).toMatchObject({ ...first, already_started: true });
  });

  it("resumes an interrupted backfill from its durable running record", async () => {
    await insertRun("resumable-run", true);
    const now = "2026-09-02T00:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO competitor_classifications (
        run_id, package_name, status, relationship, capability_category, classifier_version,
        package_url, rationale, relevant_occurrence_count, updated_at
      ) VALUES ('resumable-run', 'iconify_flutter_plus', 'complete', 'direct',
        'external app launcher', 'metadata-v0', 'https://pub.dev/packages/iconify_flutter_plus',
        'Stale classifier result.', 1, ?)`,
    ).bind(now).run();
    await env.DB.prepare(
      `INSERT INTO competitor_backfills (
        idempotency_key, requested_run_id, status, response_json, created_at, updated_at
      ) VALUES ('resumable-backfill', 'resumable-run', 'running', '{}', ?, ?)`,
    ).bind(now, now).run();
    const sent: Array<{ body: unknown }> = [];
    const queue = {
      send: async () => {},
      sendBatch: async (messages: Array<{ body: unknown }>) => { sent.push(...messages); },
    };
    const resumableEnv = new Proxy(env, {
      get(target, property, receiver) {
        return property === "SCAN_QUEUE" ? queue : Reflect.get(target, property, receiver);
      },
    }) as Env;

    const result = await startCompetitorBackfill(resumableEnv, "resumable-backfill", "resumable-run");
    expect(result).toMatchObject({
      status: "accepted",
      started_runs: ["resumable-run"],
      unavailable_runs: [],
      enqueued_count: 2,
    });
    await dispatchCompetitorClassifications(resumableEnv,"resumable-run");
    expect(sent).toHaveLength(2);
    const states = await env.DB.prepare(
      `SELECT status, classifier_version, COUNT(*) AS count FROM competitor_classifications
       WHERE run_id = 'resumable-run' GROUP BY status, classifier_version`,
    ).all<{ status: string; classifier_version: string; count: number }>();
    expect(states.results).toEqual([{ status: "queued", classifier_version: "capabilities-v2.2", count: 2 }]);
  });

  it("records retry state and converts permanent metadata failure to honest unknown", async () => {
    await env.DB.prepare(
      `UPDATE competitor_classifications SET status = 'queued'
       WHERE run_id = 'classified-run' AND package_name = 'iconify_flutter_plus'`,
    ).run();
    await recordCompetitorRetry(env, "classified-run", "iconify_flutter_plus", new RetryableCompetitorError("temporary", 10, "competitor-upstream-error"));
    let row = await env.DB.prepare(
      "SELECT status, retry_count, error_code FROM competitor_classifications WHERE run_id = 'classified-run' AND package_name = 'iconify_flutter_plus'",
    ).first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: "queued", retry_count: 1, error_code: "competitor-upstream-error" });

    await markCompetitorFailed(env, "classified-run", "iconify_flutter_plus", {
      code: "competitor-metadata-unavailable",
      message: "HTTP 404",
    });
    row = await env.DB.prepare(
      "SELECT status, relationship, relevant_occurrence_count, error_code FROM competitor_classifications WHERE run_id = 'classified-run' AND package_name = 'iconify_flutter_plus'",
    ).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      status: "failed",
      relationship: "unknown",
      relevant_occurrence_count: 0,
      error_code: "competitor-metadata-unavailable",
    });
    expect(await competitorClassificationSummary(env, "classified-run")).toMatchObject({
      status: "partial",
      failed_count: 1,
      pending_count: 0,
      relationship_counts: { direct: 1, adjacent: 0, noise: 0, unknown: 1 },
    });
  });
});
