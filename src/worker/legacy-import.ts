import { sha256Hex } from "../shared/catalog.js";
import type { LegacyImportPayload } from "../shared/types.js";
import { activeCatalog } from "./catalog-store.js";
import { storeReportArtifact } from "./artifacts.js";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function validatePayload(payload: LegacyImportPayload): Promise<void> {
  if (payload.schema_version !== 3) throw new Error("Legacy import schema must be v3.");
  if (!payload.document?.content || payload.document.content.length > 750_000) throw new Error("Legacy document is missing or too large.");
  if (await sha256Hex(payload.document.content) !== payload.document.source_hash) throw new Error("Legacy source hash does not match its content.");
  if (payload.run && payload.run.rows.length > 1_000) throw new Error("Legacy visibility import exceeds the 1,000-row limit.");
}

export async function importLegacyDocument(env: Env, payload: LegacyImportPayload): Promise<Record<string, unknown>> {
  await validatePayload(payload);
  const existing = await env.DB.prepare("SELECT id FROM migration_records WHERE source_hash = ?").bind(payload.document.source_hash).first<{ id: string }>();
  if (existing) return { status: "already-imported", migration_id: existing.id };
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO legacy_documents (
      id, document_type, filename, report_date, source_path, source_hash,
      content, provenance_json, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    payload.document.id,
    payload.document.document_type,
    payload.document.filename,
    payload.document.report_date,
    payload.document.source_path,
    payload.document.source_hash,
    payload.document.content,
    JSON.stringify(payload.document.provenance),
    now,
  ).run();

  if (!payload.run) {
    const migrationId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO migration_records (
        id, source_hash, source_path, imported_run_id, row_count, unmatched_count,
        verification_json, imported_at
      ) VALUES (?, ?, ?, NULL, 0, 0, ?, ?)`,
    ).bind(migrationId, payload.document.source_hash, payload.document.source_path, JSON.stringify({ hash_verified: true, document_only: true }), now).run();
    return { status: "imported", migration_id: migrationId, document_id: payload.document.id };
  }

  const catalog = await activeCatalog(env);
  const run = payload.run;
  await env.DB.prepare(
    `INSERT INTO runs (
      id, profile, catalog_version, report_date, requested_depth, effective_depth,
      trigger_source, idempotency_key, status, query_count, completed_count,
      failed_count, started_at, completed_at, created_at, updated_at,
      report_materialized
    ) VALUES (?, ?, ?, ?, ?, ?, 'migration', ?, 'complete', ?, ?, 0, ?, ?, ?, ?, 1)`,
  ).bind(
    run.id,
    run.profile,
    catalog.catalog_version,
    run.report_date,
    run.requested_depth,
    run.effective_depth,
    `legacy:${payload.document.source_hash}`,
    run.rows.length,
    run.rows.length,
    now,
    now,
    now,
    now,
  ).run();

  const statements = run.rows.map((row) => env.DB.prepare(
    `INSERT INTO run_queries (
      run_id, query_id, query, lane, product_area, expression_type, product_fit,
      tags_json, sources_json, definition_hash, requested_depth, actual_depth,
      rank, pages_scanned, next_page, exhausted, status, retry_count,
      packages_json, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', 0, ?, ?, ?, ?)`,
  ).bind(
    run.id,
    row.query_id,
    row.query,
    row.lane,
    row.product_area,
    row.expression_type,
    row.product_fit,
    JSON.stringify(row.tags),
    JSON.stringify([...row.sources, { type: "legacy", location: payload.document.source_path, derivation: JSON.stringify(row.provenance) }]),
    row.definition_hash,
    row.requested_depth,
    row.actual_depth,
    row.rank,
    Math.max(1, Math.ceil(row.actual_depth / 10)),
    Math.max(2, Math.ceil(row.actual_depth / 10) + 1),
    row.exhausted ? 1 : 0,
    JSON.stringify(row.packages),
    now,
    now,
    now,
  ));
  for (let index = 0; index < statements.length; index += 75) await env.DB.batch(statements.slice(index, index + 75));

  const ranked = run.rows.filter((row) => row.rank !== null);
  const positions = ranked.map((row) => env.DB.prepare(
    "INSERT INTO search_positions (run_id, query_id, package_name, position, page) VALUES (?, ?, ?, ?, ?)",
  ).bind(run.id, row.query_id, env.PACKAGE_NAME, row.rank, Math.ceil(row.rank! / 10)));
  for (let index = 0; index < positions.length; index += 75) await env.DB.batch(positions.slice(index, index + 75));

  const snapshot = run.snapshot;
  await env.DB.prepare(
    `INSERT INTO package_snapshots (
      id, run_id, package_name, published_version, published_at, published_description,
      published_topics_json, repository_version, repository_description, points,
      max_points, likes, downloads_30d, package_url, score_url, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    run.id,
    env.PACKAGE_NAME,
    snapshot.published_version,
    snapshot.published_at,
    snapshot.published_description,
    JSON.stringify(snapshot.published_topics),
    snapshot.repository_version,
    snapshot.repository_description,
    snapshot.points,
    snapshot.max_points,
    snapshot.likes,
    snapshot.downloads_30d,
    `https://pub.dev/packages/${env.PACKAGE_NAME}`,
    `https://pub.dev/packages/${env.PACKAGE_NAME}/score`,
    `${run.report_date}T23:59:59.000Z`,
  ).run();

  const csvHeaders = ["query_id", "query", "lane", "rank", "requested_depth", "actual_depth", "exhausted"];
  const csv = `${csvHeaders.join(",")}\n${run.rows.map((row) => [row.query_id, row.query, row.lane, row.rank, row.requested_depth, row.actual_depth, row.exhausted].map(csvCell).join(",")).join("\n")}\n`;
  const normalizedJson = `${JSON.stringify({ schema_version: 3, migration: payload.document.provenance, run, source_hash: payload.document.source_hash }, null, 2)}\n`;
  const base = payload.document.filename.replace(/\.md$/i, "");
  const artifacts = [
    { type: "markdown", filename: `${base}.md`, contentType: "text/markdown; charset=utf-8", content: payload.document.content },
    { type: "csv", filename: `${base}.csv`, contentType: "text/csv; charset=utf-8", content: csv },
    { type: "json", filename: `${base}.json`, contentType: "application/json; charset=utf-8", content: normalizedJson },
  ];
  for (const artifact of artifacts) {
    await storeReportArtifact(env, {
      id: `${run.id}:${artifact.type}`, runId: run.id, type: artifact.type as "markdown" | "csv" | "json",
      filename: artifact.filename, contentType: artifact.contentType, content: artifact.content,
      contentHash: await sha256Hex(artifact.content), createdAt: now,
    });
  }

  const migrationId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO migration_records (
      id, source_hash, source_path, imported_run_id, row_count, unmatched_count,
      verification_json, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    migrationId,
    payload.document.source_hash,
    payload.document.source_path,
    run.id,
    run.rows.length,
    run.unmatched_rows,
    JSON.stringify({
      hash_verified: true,
      ignored_baseline_rows: run.ignored_baseline_rows,
      normalized_rows: run.rows.length,
      profile: run.profile,
      requested_depth: run.requested_depth,
    }),
    now,
  ).run();
  return { status: "imported", migration_id: migrationId, document_id: payload.document.id, run_id: run.id, row_count: run.rows.length };
}
