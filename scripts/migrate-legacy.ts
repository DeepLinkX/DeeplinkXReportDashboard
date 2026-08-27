import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalize, sha256Hex, stableJson, stableQueryId, validateCatalog } from "../src/shared/catalog.js";
import type { CatalogManifest, LegacyImportPayload, QueryDefinition } from "../src/shared/types.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

export interface MigrationArguments {
  sourceRoot: string;
  outputRoot: string;
  endpoint: string | null;
  tokenVariable: string;
}

function argumentValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function isInsideProject(target: string): boolean {
  const relative = path.relative(projectRoot, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function parseMigrationArguments(argv: string[]): MigrationArguments {
  const source = argumentValue(argv, "--source-dir");
  const output = argumentValue(argv, "--output-dir");
  if (!source || !output) {
    throw new Error("Legacy migration requires --source-dir and --output-dir.");
  }
  const outputRoot = path.resolve(output);
  if (isInsideProject(outputRoot)) {
    throw new Error("Legacy migration output must stay outside the report-dashboard repository.");
  }
  return {
    sourceRoot: path.resolve(source),
    outputRoot,
    endpoint: argumentValue(argv, "--upload"),
    tokenVariable: argumentValue(argv, "--token-env") ?? "DEEPLINKX_VISIBILITY_ADMIN_TOKEN",
  };
}

const profiles: Record<string, { profile: "pulse" | "full" | "legacy-mixed"; depth: number; effective: number | null }> = {
  "2026-07-01": { profile: "legacy-mixed", depth: 100, effective: null },
  "2026-07-06": { profile: "full", depth: 100, effective: 100 },
  "2026-07-10": { profile: "full", depth: 100, effective: 100 },
  "2026-07-19": { profile: "full", depth: 100, effective: 100 },
  "2026-08-10": { profile: "pulse", depth: 10, effective: 10 },
  "2026-08-27": { profile: "pulse", depth: 10, effective: 10 },
};

function scalarMatch(content: string, expression: RegExp): string | null {
  return content.match(expression)?.[1]?.trim() ?? null;
}

function numericSignal(content: string, label: string): number | null {
  const raw = scalarMatch(content, new RegExp(`\\|\\s*${label}\\s*\\|\\s*([0-9,]+)`, "i"));
  return raw ? Number(raw.replaceAll(",", "")) : null;
}

export function packageSnapshot(content: string, repositoryDescription: string) {
  const publishedVersion = scalarMatch(content, /(?:latest as|latest is)\s+`([^`]+)`/i);
  const publishedAt = scalarMatch(content, /published on\s+`([^`]+)`/i);
  const description = scalarMatch(content, /```ya?ml\s*description:\s*([^\n]+)\s*```/i);
  const localVersion = scalarMatch(content, /(?:local `pubspec\.yaml` is|checkout is)\s+`([^`]+)`/i) ?? publishedVersion;
  const topicsLine = scalarMatch(content, /\|\s*Topics\s*\|\s*([^\n|]+)/i) ?? "";
  return {
    published_version: publishedVersion,
    published_at: publishedAt,
    published_description: description,
    published_topics: [...topicsLine.matchAll(/`([^`]+)`/g)].map((match) => match[1]),
    repository_version: localVersion,
    repository_description: description ?? repositoryDescription,
    points: numericSignal(content, "Pub points"),
    max_points: Number(scalarMatch(content, /\|\s*Pub points\s*\|\s*[0-9,]+\s*\/\s*([0-9,]+)/i)?.replaceAll(",", "") ?? 0) || null,
    likes: numericSignal(content, "Likes"),
    downloads_30d: numericSignal(content, "30-day downloads"),
  };
}

function inferredLane(section: string, query: string): { lane: string; productArea: string; productFit: "medium" | "low" } {
  const sentenceStyle = /\b(?:how|from flutter|using flutter|without|with coordinates|phone number)\b/i.test(query) || query.split(/\s+/).length > 6;
  if (sentenceStyle) return { lane: "legacy-content", productArea: section || "content-discovery", productFit: "low" };
  return { lane: "legacy-retired", productArea: section || "legacy", productFit: "medium" };
}

async function definitionHash(query: QueryDefinition): Promise<string> {
  return sha256Hex(stableJson({
    query: query.query,
    lane: query.lane,
    product_area: query.product_area,
    expression_type: query.expression_type,
    product_fit: query.product_fit,
    tags: query.tags,
    sources: query.sources,
  }));
}

export async function parseVisibility(
  filename: string,
  content: string,
  sourceHash: string,
  currentByQuery: Map<string, QueryDefinition>,
  repositoryDescription: string,
): Promise<LegacyImportPayload> {
  const date = filename.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!date || !profiles[date]) throw new Error(`Unsupported visibility report: ${filename}`);
  const profile = profiles[date];
  let section = "legacy";
  let majorSection = "";
  let ignoredBaselineRows = 0;
  let unscannedRows = 0;
  let unmatchedRows = 0;
  const rows = new Map<string, LegacyImportPayload["run"] extends infer _ ? NonNullable<LegacyImportPayload["run"]>["rows"][number] : never>();
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const majorHeading = line.match(/^##\s+(.+)/)?.[1];
    if (majorHeading) majorSection = normalize(majorHeading);
    const heading = line.match(/^###\s+(.+)/)?.[1];
    if (heading) section = normalize(heading).replaceAll(" ", "-");
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const tableQuery = cells[0]?.match(/^`(.+)`$/)?.[1]?.trim();
    const candidates: Array<{ query: string; resultText: string; matrix: boolean }> = [];
    if (tableQuery) candidates.push({ query: tableQuery, resultText: cells[1] ?? "", matrix: false });
    if (!tableQuery && majorSection === "app-specific competitor matrix" && cells.length >= 5 && cells[0] && !/^(?:app|---)$/.test(normalize(cells[0]))) {
      const app = cells[0];
      candidates.push(
        { query: app, resultText: cells[1] ?? "", matrix: true },
        { query: `${app} link`, resultText: cells[2] ?? "", matrix: true },
        { query: `${app} deeplink`, resultText: cells[3] ?? "", matrix: true },
        { query: `open ${app} from Flutter`, resultText: cells[4] ?? "", matrix: true },
      );
    }
    for (const { query, resultText, matrix } of candidates) {
      if (/baseline-only/i.test(resultText)) { ignoredBaselineRows += 1; continue; }
      if (/not scanned/i.test(resultText)) { unscannedRows += 1; continue; }
      const rank = Number(resultText.match(/#(\d+)/)?.[1] ?? 0) || null;
      const missingDepth = Number(resultText.match(/not in (?:the )?top\s+(\d+)/i)?.[1] ?? 0) || null;
      if (rank === null && missingDepth === null) continue;
      let actualDepth = profile.depth;
      if (profile.profile === "legacy-mixed") {
        const page = Number(resultText.match(/\bp(\d+)\b/i)?.[1] ?? 0);
        actualDepth = missingDepth ?? (page ? page * 10 : rank ?? 10);
      } else if (missingDepth) {
        actualDepth = missingDepth;
      }
      const current = currentByQuery.get(normalize(query));
      let queryId: string;
      let lane: string;
      let productArea: string;
      let expressionType: "raw" | "sdk-filter" | "topic-filter";
      let productFit: "high" | "medium" | "low";
      let tags: Record<string, string>;
      let sources: Array<{ type: string; location: string; derivation: string }>;
      let hash: string;
      if (current) {
        queryId = current.query_id;
        lane = current.lane;
        productArea = current.product_area;
        expressionType = current.expression_type;
        productFit = current.product_fit;
        tags = current.tags;
        sources = current.sources;
        hash = await definitionHash(current);
      } else {
        unmatchedRows += 1;
        const inferred = inferredLane(matrix ? "app-matrix" : section, query);
        queryId = `legacy_${(await stableQueryId(query, "raw")).slice(2)}`;
        lane = inferred.lane;
        productArea = inferred.productArea;
        expressionType = "raw";
        productFit = inferred.productFit;
        tags = matrix ? { provider: cells[0] } : {};
        sources = [{ type: "legacy", location: `doc/keywords/${filename}`, derivation: `Unmatched historical query from ${matrix ? "app matrix" : section}` }];
        hash = await sha256Hex(stableJson({ query: normalize(query), lane, product_area: productArea, expression_type: expressionType }));
      }
      const key = normalize(query);
      const row = {
        query_id: queryId,
        query,
        lane,
        product_area: productArea,
        expression_type: expressionType,
        product_fit: productFit,
        tags,
        sources,
        definition_hash: hash,
        requested_depth: profile.profile === "legacy-mixed" ? actualDepth : profile.depth,
        actual_depth: actualDepth,
        rank,
        exhausted: false,
        packages: [],
        provenance: { source_line: index + 1, source_result: resultText, section: matrix ? "app-matrix" : section, exact_v3_match: Boolean(current) },
      };
      const previous = rows.get(key);
      if (!previous || (previous.rank === null && row.rank !== null)) rows.set(key, row);
    }
  }
  const sourcePath = `doc/keywords/${filename}`;
  const documentId = `legacy_${sourceHash.slice(0, 20)}`;
  return {
    schema_version: 3,
    document: {
      id: documentId,
      document_type: "visibility",
      filename,
      report_date: date,
      source_path: sourcePath,
      source_hash: sourceHash,
      content,
      provenance: {
        migration_schema: 3,
        normalization: profile,
        baseline_only: "Ignored in the containing snapshot and retained in the source document; original snapshots remain authoritative.",
        unmatched_queries: "Preserved as legacy rows and excluded from future scans.",
      },
    },
    run: {
      id: `legacy-visibility-${date}`,
      profile: profile.profile,
      report_date: date,
      requested_depth: profile.depth,
      effective_depth: profile.effective,
      rows: [...rows.values()].sort((left, right) => normalize(left.query).localeCompare(normalize(right.query))),
      snapshot: packageSnapshot(content, repositoryDescription),
      ignored_baseline_rows: ignoredBaselineRows,
      unmatched_rows: unmatchedRows,
    },
  };
}

async function parseComparison(filename: string, content: string, sourceHash: string): Promise<LegacyImportPayload> {
  const dates = [...filename.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((match) => match[0]);
  return {
    schema_version: 3,
    document: {
      id: `legacy_${sourceHash.slice(0, 20)}`,
      document_type: "comparison",
      filename,
      report_date: dates.at(-1) ?? null,
      source_path: `doc/keywords/${filename}`,
      source_hash: sourceHash,
      content,
      provenance: {
        migration_schema: 3,
        original_range: dates,
        dashboard_behavior: "Stored as migration evidence; public movement is recomputed from normalized visibility snapshots.",
      },
    },
  };
}

async function upload(payloads: LegacyImportPayload[], endpoint: string, token: string): Promise<void> {
  for (const payload of payloads) {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/v1/admin/legacy/import`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": `legacy:${payload.document.source_hash}`,
      },
      body: JSON.stringify(payload),
    });
    const result = await response.text();
    if (!response.ok) throw new Error(`${payload.document.filename}: HTTP ${response.status}: ${result}`);
    process.stdout.write(`${payload.document.filename}: ${result}\n`);
  }
}

async function main(): Promise<void> {
  const arguments_ = parseMigrationArguments(process.argv.slice(2));
  const sourceStat = await fs.stat(arguments_.sourceRoot).catch(() => null);
  if (!sourceStat?.isDirectory()) throw new Error(`Legacy source directory does not exist: ${arguments_.sourceRoot}`);
  const catalogJson = JSON.parse(await fs.readFile(path.join(projectRoot, "catalog", "catalog-v3.json"), "utf8")) as CatalogManifest;
  const catalog = await validateCatalog(catalogJson);
  const currentByQuery = new Map(catalog.queries.map((query) => [normalize(query.query), query]));
  const files = (await fs.readdir(arguments_.sourceRoot)).filter((filename) => /^pubdev_keyword_(?:visibility_report|comparison)_.*\.md$/.test(filename)).sort();
  const payloads: LegacyImportPayload[] = [];
  await fs.mkdir(arguments_.outputRoot, { recursive: true });
  for (const filename of files) {
    const content = await fs.readFile(path.join(arguments_.sourceRoot, filename), "utf8");
    const sourceHash = await sha256Hex(content);
    const payload = filename.includes("visibility_report")
      ? await parseVisibility(filename, content, sourceHash, currentByQuery, catalog.product.repository_description)
      : await parseComparison(filename, content, sourceHash);
    payloads.push(payload);
    await fs.writeFile(path.join(arguments_.outputRoot, `${filename}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  const summary = payloads.map((payload) => ({
    filename: payload.document.filename,
    hash: payload.document.source_hash,
    rows: payload.run?.rows.length ?? 0,
    ignored_baseline_rows: payload.run?.ignored_baseline_rows ?? 0,
    unmatched_rows: payload.run?.unmatched_rows ?? 0,
  }));
  await fs.writeFile(path.join(arguments_.outputRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`Prepared ${payloads.length} legacy documents in ${arguments_.outputRoot}.\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (arguments_.endpoint) {
    const token = process.env[arguments_.tokenVariable];
    if (!token) throw new Error(`Upload requires the ${arguments_.tokenVariable} environment variable.`);
    await upload(payloads, arguments_.endpoint, token);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
