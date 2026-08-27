import { NOISE_TERMS, normalize, semanticText, sha256Hex } from "../shared/catalog.js";
import type { RecommendationClass } from "../shared/types.js";

interface RunRow {
  id: string;
  profile: "pulse" | "full" | "legacy-mixed";
  catalog_version: string;
  report_date: string;
  requested_depth: number;
  status: string;
  query_count: number;
  completed_count: number;
  failed_count: number;
  trigger_source: string;
  created_at: string;
  report_materialized: number;
}

interface QueryRow {
  run_id: string;
  query_id: string;
  query: string;
  lane: string;
  product_area: string;
  expression_type: string;
  product_fit: string;
  tags_json: string;
  sources_json: string;
  definition_hash: string;
  requested_depth: number;
  actual_depth: number;
  rank: number | null;
  pages_scanned: number;
  exhausted: number;
  status: string;
  retry_count: number;
  packages_json: string;
  error_code: string | null;
}

interface SnapshotRow {
  published_version: string | null;
  published_at: string | null;
  published_description: string | null;
  published_topics_json: string;
  repository_version: string | null;
  repository_description: string | null;
  points: number | null;
  max_points: number | null;
  likes: number | null;
  downloads_30d: number | null;
  captured_at: string;
}

interface CompetitorRow {
  package_name: string;
  occurrence_count: number;
  best_rank: number;
  median_rank: number;
  category: string;
}

interface RecommendationRow {
  query_id: string;
  class: RecommendationClass;
  priority: number;
  rationale: string;
  evidence_json: string;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function percent(value: number, total: number): string {
  return total ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";
}

function rankLabel(row: QueryRow): string {
  if (row.status === "failed") return "INCOMPLETE";
  if (row.rank !== null) return `#${row.rank}`;
  if (row.exhausted) return `Not found (results exhausted after ${row.actual_depth})`;
  return `Not found in top ${row.requested_depth}`;
}

function phraseCovered(query: string, text: string): boolean {
  const queryTokens = semanticText(query.replace(/\b(?:sdk|topic):\w+\b/gi, ""))
    .split(" ")
    .filter((token) => token.length > 1 && !["app", "link"].includes(token));
  const haystack = new Set(semanticText(text).split(" "));
  return queryTokens.length > 0 && queryTokens.every((token) => haystack.has(token));
}

export function recommendation(
  query: QueryRow,
  publishedText: string,
  repositoryText: string,
): Omit<RecommendationRow, "query_id"> {
  const isNoise = query.product_fit !== "high" || NOISE_TERMS.has(normalize(query.query));
  if (query.rank !== null && query.rank <= 3 && query.product_fit === "high") {
    return {
      class: "protect",
      priority: 10 + query.rank,
      rationale: "High-fit compact query currently ranks in the top three.",
      evidence_json: JSON.stringify({ rank: query.rank, completed_depth: query.requested_depth }),
    };
  }
  if (isNoise) {
    return {
      class: "noise",
      priority: 90,
      rationale: "Broad wording is ambiguous across unrelated package categories.",
      evidence_json: JSON.stringify({ product_fit: query.product_fit, rank: query.rank }),
    };
  }
  if (["provider", "navigation", "action", "store"].includes(query.lane) && !phraseCovered(query.query, repositoryText)) {
    return {
      class: "capability gap",
      priority: query.rank === null ? 30 : 40,
      rationale: "Repository evidence supports this area, but the compact phrase is not covered by package landing metadata.",
      evidence_json: JSON.stringify({ sources: JSON.parse(query.sources_json), rank: query.rank }),
    };
  }
  if (!phraseCovered(query.query, publishedText)) {
    return {
      class: "metadata gap",
      priority: query.rank === null ? 20 : 35,
      rationale: "The compact phrase is absent from the published package name, description, and topics.",
      evidence_json: JSON.stringify({ rank: query.rank, published_metadata_match: false }),
    };
  }
  return {
    class: "authority gap",
    priority: query.rank === null ? 25 : 45 + Math.min(query.rank, 40),
    rationale: "The phrase appears in published metadata, but other packages rank ahead or DeeplinkX is absent at the completed depth.",
    evidence_json: JSON.stringify({ rank: query.rank, completed_depth: query.requested_depth, published_metadata_match: true }),
  };
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

async function aggregateCompetitors(env: Env, runId: string): Promise<CompetitorRow[]> {
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

async function replaceDerivedRows(
  env: Env,
  runId: string,
  competitors: CompetitorRow[],
  recommendations: RecommendationRow[],
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM competitors WHERE run_id = ?").bind(runId),
    env.DB.prepare("DELETE FROM recommendations WHERE run_id = ?").bind(runId),
  ]);
  const statements = [
    ...competitors.map((row) => env.DB.prepare(
      `INSERT INTO competitors (run_id, package_name, occurrence_count, best_rank, median_rank, category)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(runId, row.package_name, row.occurrence_count, row.best_rank, row.median_rank, row.category)),
    ...recommendations.map((row) => env.DB.prepare(
      `INSERT INTO recommendations (run_id, query_id, class, priority, rationale, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(runId, row.query_id, row.class, row.priority, row.rationale, row.evidence_json)),
  ];
  for (let index = 0; index < statements.length; index += 75) await env.DB.batch(statements.slice(index, index + 75));
}

function coverage(queries: QueryRow[]): { total: number; top_1: number; top_3: number; top_10: number } {
  const core = queries.filter((query) => query.lane === "compact-core" && query.status === "complete");
  return {
    total: core.length,
    top_1: core.filter((query) => query.rank === 1).length,
    top_3: core.filter((query) => query.rank !== null && query.rank <= 3).length,
    top_10: core.filter((query) => query.rank !== null && query.rank <= 10).length,
  };
}

function matrixRows(queries: QueryRow[], tagName: "provider" | "store"): Array<{ name: string; visible: number; best: number | null; queries: number }> {
  const grouped = new Map<string, QueryRow[]>();
  for (const query of queries) {
    const tag = (JSON.parse(query.tags_json) as Record<string, string>)[tagName];
    if (!tag) continue;
    grouped.set(tag, [...(grouped.get(tag) ?? []), query]);
  }
  return [...grouped.entries()].map(([name, rows]) => {
    const ranks = rows.flatMap((row) => row.rank === null ? [] : [row.rank]);
    return { name, visible: ranks.length, best: ranks.length ? Math.min(...ranks) : null, queries: rows.length };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function renderMarkdown(
  run: RunRow,
  queries: QueryRow[],
  snapshot: SnapshotRow | null,
  competitors: CompetitorRow[],
  recommendations: RecommendationRow[],
): string {
  const title = run.profile === "pulse" ? "Release Pulse" : run.profile === "full" ? "Full Audit" : "Legacy Snapshot";
  const counts = coverage(queries);
  const providerRows = matrixRows(queries, "provider");
  const storeRows = matrixRows(queries, "store");
  const lines = [
    `# DeeplinkX pub.dev Visibility ${title} — ${run.report_date}`,
    "",
    `Status: **${run.failed_count ? "Incomplete" : "Complete"}**`,
    "",
    "## Method and boundaries",
    "",
    `- Profile: \`${run.profile}\`; requested depth: top ${run.requested_depth}.`,
    `- Catalog: \`${run.catalog_version}\`; ${run.query_count} compact developer searches.`,
    `- Completed queries: ${run.completed_count}; permanently failed queries: ${run.failed_count}.`,
    "- Rank is bounded pub.dev visibility. It is not search volume, traffic, conversion, popularity, revenue, or business demand.",
    "- Failed queries are marked `INCOMPLETE`; they are never converted into missing ranks.",
    "",
    "## Package snapshot",
    "",
    "| Signal | Published | Repository checkout |",
    "| --- | ---: | ---: |",
    `| Version | \`${snapshot?.published_version ?? "not captured"}\` | \`${snapshot?.repository_version ?? "not captured"}\` |`,
    `| Published at | ${snapshot?.published_at ?? "not captured"} | — |`,
    `| Pub points | ${snapshot?.points ?? "not captured"}${snapshot?.max_points === null || snapshot?.max_points === undefined ? "" : ` / ${snapshot.max_points}`} | — |`,
    `| Likes | ${snapshot?.likes ?? "not captured"} | — |`,
    `| 30-day downloads | ${snapshot?.downloads_30d ?? "not captured"} | — |`,
    "",
    "## Compact-core coverage",
    "",
    "| Threshold | Visible queries | Coverage |",
    "| --- | ---: | ---: |",
    `| Top 1 | ${counts.top_1} / ${counts.total} | ${percent(counts.top_1, counts.total)} |`,
    `| Top 3 | ${counts.top_3} / ${counts.total} | ${percent(counts.top_3, counts.total)} |`,
    `| Top 10 | ${counts.top_10} / ${counts.total} | ${percent(counts.top_10, counts.total)} |`,
    "",
    "## Structured-query visibility",
    "",
    "| Expression | Type | Result |",
    "| --- | --- | ---: |",
    ...queries.filter((query) => query.lane === "structured").map((query) => `| \`${query.query}\` | ${query.expression_type} | ${rankLabel(query)} |`),
    "",
    "## Provider visibility",
    "",
    "| Provider | Visible queries | Best rank | Query count |",
    "| --- | ---: | ---: | ---: |",
    ...(providerRows.length ? providerRows.map((row) => `| ${row.name} | ${row.visible} | ${row.best === null ? "—" : `#${row.best}`} | ${row.queries} |`) : ["| — | 0 | — | 0 |"]),
    "",
    "## Store visibility",
    "",
    "| Store | Visible queries | Best rank | Query count |",
    "| --- | ---: | ---: | ---: |",
    ...(storeRows.length ? storeRows.map((row) => `| ${row.name} | ${row.visible} | ${row.best === null ? "—" : `#${row.best}`} | ${row.queries} |`) : ["| — | 0 | — | 0 |"]),
    "",
    "## Navigation visibility",
    "",
    "| Provider | Capability | Query | Result |",
    "| --- | --- | --- | ---: |",
    ...queries.filter((query) => (JSON.parse(query.tags_json) as Record<string, string>).capability).map((query) => {
      const tags = JSON.parse(query.tags_json) as Record<string, string>;
      return `| ${tags.provider ?? "—"} | ${tags.capability ?? "—"} | \`${query.query}\` | ${rankLabel(query)} |`;
    }),
    "",
    "## Competitor analysis",
    "",
    "Frequency is the number of this run's bounded queries where a package appeared; it is not market share.",
    "",
    "| Package | Query appearances | Best | Median | Relevant category |",
    "| --- | ---: | ---: | ---: | --- |",
    ...competitors.slice(0, 100).map((row) => `| [${row.package_name}](https://pub.dev/packages/${row.package_name}) | ${row.occurrence_count} | #${row.best_rank} | ${row.median_rank} | ${row.category} |`),
    "",
    "## Prioritized recommendations",
    "",
    "| Class | Query | Result | Evidence-based rationale |",
    "| --- | --- | ---: | --- |",
    ...recommendations.slice(0, 100).map((item) => {
      const query = queries.find((row) => row.query_id === item.query_id)!;
      return `| ${item.class} | \`${query.query}\` | ${rankLabel(query)} | ${item.rationale} |`;
    }),
    "",
    "## Complete normalized result appendix",
    "",
    "| Query ID | Query | Lane | Result | Actual depth | Pages | Exhausted |",
    "| --- | --- | --- | ---: | ---: | ---: | --- |",
    ...queries.map((query) => `| \`${query.query_id}\` | \`${query.query.replaceAll("|", "\\|")}\` | ${query.lane} | ${rankLabel(query)} | ${query.actual_depth} | ${query.pages_scanned} | ${query.exhausted ? "yes" : "no"} |`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function reportJson(
  run: RunRow,
  queries: QueryRow[],
  snapshot: SnapshotRow | null,
  competitors: CompetitorRow[],
  recommendations: RecommendationRow[],
): string {
  return `${JSON.stringify({
    schema_version: 3,
    run,
    package_snapshot: snapshot ? { ...snapshot, published_topics: JSON.parse(snapshot.published_topics_json) } : null,
    coverage: coverage(queries),
    queries: queries.map((query) => ({
      ...query,
      tags: JSON.parse(query.tags_json),
      sources: JSON.parse(query.sources_json),
      packages: JSON.parse(query.packages_json),
      tags_json: undefined,
      sources_json: undefined,
      packages_json: undefined,
    })),
    competitors,
    recommendations: recommendations.map((item) => ({ ...item, evidence: JSON.parse(item.evidence_json), evidence_json: undefined })),
    interpretation: "Ranks are bounded pub.dev visibility, not volume, traffic, conversion, popularity, revenue, or demand.",
  }, null, 2)}\n`;
}

function reportCsv(queries: QueryRow[]): string {
  const headers = ["query_id", "query", "lane", "product_area", "expression_type", "product_fit", "rank", "requested_depth", "actual_depth", "pages_scanned", "exhausted", "status", "retry_count"];
  const rows = queries.map((query) => headers.map((header) => csvCell(query[header as keyof QueryRow])).join(","));
  return `${headers.join(",")}\n${rows.join("\n")}\n`;
}

async function storeArtifact(
  env: Env,
  runId: string,
  type: "markdown" | "csv" | "json",
  filename: string,
  contentType: string,
  content: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO report_artifacts (id, run_id, artifact_type, filename, content_type, content, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, artifact_type) DO UPDATE SET
       filename = excluded.filename,
       content_type = excluded.content_type,
       content = excluded.content,
       content_hash = excluded.content_hash`,
  ).bind(`${runId}:${type}`, runId, type, filename, contentType, content, await sha256Hex(content), now).run();
}

export async function finalizeRun(env: Env, runId: string): Promise<void> {
  const run = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first<RunRow>();
  if (!run) throw new Error(`Unknown run ${runId}.`);
  if (run.report_materialized) return;
  const queryResult = await env.DB.prepare("SELECT * FROM run_queries WHERE run_id = ? ORDER BY lane, query").bind(runId).all<QueryRow>();
  const queries = queryResult.results;
  if (queries.length !== run.query_count) throw new Error(`Run ${runId} has an incomplete query definition set.`);
  const snapshot = await env.DB.prepare(
    "SELECT * FROM package_snapshots WHERE run_id = ? ORDER BY captured_at DESC LIMIT 1",
  ).bind(runId).first<SnapshotRow>();
  const publishedText = `${env.PACKAGE_NAME} ${snapshot?.published_description ?? ""} ${JSON.parse(snapshot?.published_topics_json ?? "[]").join(" ")}`;
  const repositoryText = `${env.PACKAGE_NAME} ${snapshot?.repository_description ?? ""}`;
  const recommendations = queries
    .filter((query) => query.status === "complete")
    .map((query) => ({ query_id: query.query_id, ...recommendation(query, publishedText, repositoryText) }))
    .sort((left, right) => left.priority - right.priority || left.query_id.localeCompare(right.query_id));
  const competitors = await aggregateCompetitors(env, runId);
  await replaceDerivedRows(env, runId, competitors, recommendations);

  const base = `pubdev_keyword_visibility_${run.profile}_${run.report_date}`;
  await storeArtifact(env, runId, "markdown", `${base}.md`, "text/markdown; charset=utf-8", renderMarkdown(run, queries, snapshot, competitors, recommendations));
  await storeArtifact(env, runId, "csv", `${base}.csv`, "text/csv; charset=utf-8", reportCsv(queries));
  await storeArtifact(env, runId, "json", `${base}.json`, "application/json; charset=utf-8", reportJson(run, queries, snapshot, competitors, recommendations));

  const now = new Date().toISOString();
  const finalStatus = run.failed_count ? "incomplete" : "complete";
  await env.DB.prepare(
    `UPDATE runs SET status = ?, effective_depth = requested_depth, report_materialized = 1,
      completed_at = ?, updated_at = ?, error_summary = CASE WHEN failed_count > 0
        THEN failed_count || ' query messages failed; failed rows remain INCOMPLETE.' ELSE NULL END
     WHERE id = ?`,
  ).bind(finalStatus, now, now, runId).run();
}
