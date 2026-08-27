import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG_REVISION,
  FIXED_CORE,
  HERO_APPS,
  NOISE_TERMS,
  PACKAGE_NAME,
  SDK_SEARCHES,
  addQuery,
  catalogHash,
  normalize,
  validateCatalog,
} from "../src/shared/catalog.js";
import type { CatalogManifest, QueryDefinition } from "../src/shared/types.js";

interface ProductDoc {
  name: string;
  location: string;
  headings: string[];
  isStore: boolean;
}

export interface GeneratorArguments {
  sourceRepo: string;
  outputPath: string;
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const defaultOutputPath = path.join(projectRoot, "catalog", "catalog-v3.json");

// Query definition hashes include evidence. Keep this stable identifier across
// the repository extraction so relocation alone does not redefine 48 queries.
export const STABLE_FIXED_CATALOG_SOURCE = "tool/pubdev_visibility/catalog/catalog-v3.json";

function argumentValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

export function parseGeneratorArguments(argv: string[]): GeneratorArguments {
  const sourceRepo = argumentValue(argv, "--source-repo");
  if (!sourceRepo) throw new Error("Catalog generation requires --source-repo /path/to/deeplink_x.");
  const output = argumentValue(argv, "--output");
  return {
    sourceRepo: path.resolve(sourceRepo),
    outputPath: output ? path.resolve(output) : defaultOutputPath,
  };
}

async function requirePath(root: string, relative: string, directory = false): Promise<void> {
  const target = path.join(root, relative);
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new Error(`DeeplinkX source repository is missing ${relative}.`);
  }
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`DeeplinkX source repository has an invalid ${relative}.`);
  }
}

export async function validateSourceRepository(input: string): Promise<string> {
  let repositoryRoot: string;
  try {
    repositoryRoot = await fs.realpath(path.resolve(input));
  } catch {
    throw new Error(`DeeplinkX source repository does not exist: ${path.resolve(input)}`);
  }
  await Promise.all([
    requirePath(repositoryRoot, "pubspec.yaml"),
    requirePath(repositoryRoot, "README.md"),
    requirePath(repositoryRoot, path.join("doc", "apps"), true),
  ]);
  const pubspecText = await fs.readFile(path.join(repositoryRoot, "pubspec.yaml"), "utf8");
  if (parseScalar(pubspecText, "name") !== PACKAGE_NAME) {
    throw new Error(`--source-repo must be the ${PACKAGE_NAME} product repository.`);
  }

  let gitRoot: string;
  try {
    gitRoot = await fs.realpath(execFileSync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: repositoryRoot, encoding: "utf8" },
    ).trim());
  } catch {
    throw new Error(`DeeplinkX source repository is not a Git worktree: ${repositoryRoot}`);
  }
  if (gitRoot !== repositoryRoot) {
    throw new Error(`--source-repo must point to the DeeplinkX Git root: ${gitRoot}`);
  }

  const dirtyEvidence = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", "pubspec.yaml", "README.md", "doc/apps"],
    { cwd: repositoryRoot, encoding: "utf8" },
  ).trim();
  if (dirtyEvidence) {
    throw new Error("DeeplinkX product evidence is dirty; commit or stash pubspec.yaml, README.md, and doc/apps before generating a committed catalog.");
  }
  return repositoryRoot;
}

function parseScalar(text: string, name: string): string {
  return text.match(new RegExp(`^${name}:\\s*['\"]?([^\\n'\"]+)`, "m"))?.[1]?.trim() ?? "";
}

function parseTopics(text: string): string[] {
  const body = text.match(/^topics:\s*\n((?:\s+-[^\n]*\n?)+)/m)?.[1] ?? "";
  return [...body.matchAll(/^\s+-\s*([^#\n]+)/gm)].map((match) => match[1].trim());
}

async function markdownFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await markdownFiles(target));
    if (entry.isFile() && entry.name.endsWith(".md")) output.push(target);
  }
  return output.sort();
}

function docTitle(text: string, filename: string): string {
  const heading = text.match(/^#\s+(.+?)(?:\s+Deeplinks?)?\s*$/m)?.[1]?.trim();
  if (heading) return heading;
  return path.basename(filename, ".md").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function readDocs(repositoryRoot: string): Promise<ProductDoc[]> {
  const docsRoot = path.join(repositoryRoot, "doc", "apps");
  const files = await markdownFiles(docsRoot);
  return Promise.all(files.map(async (filename) => {
    const text = await fs.readFile(filename, "utf8");
    return {
      name: docTitle(text, filename),
      location: path.relative(repositoryRoot, filename),
      headings: [...text.matchAll(/^###\s+(.+?)\s*$/gm)]
        .map((match) => match[1].replace(/\s+Action$/i, "").trim())
        .filter((heading) => !/^(?:iOS|Android|Web|Native|Store|Fallback)/i.test(heading)),
      isStore: path.relative(docsRoot, filename).split(path.sep).includes("stores"),
    };
  }));
}

function documentedCapabilities(headings: string[]): string[] {
  const text = headings.join(" ").toLocaleLowerCase("en-US");
  const rules: Array<[string, RegExp]> = [
    ["map", /\b(?:view map|show map|map view)\b/],
    ["search", /\bsearch\b/],
    ["directions", /\bdirections?\b|\broute\b/],
    ["coordinates", /\bcoordinates?\b|\bcoords?\b/],
    ["navigation", /\bnavigat(?:e|ion)\b/],
  ];
  const capabilities = rules.filter(([, expression]) => expression.test(text)).map(([name]) => name);
  const hasNavigationEvidence = capabilities.some((capability) => capability !== "search");
  return hasNavigationEvidence ? ["launcher", ...capabilities] : [];
}

const actionStopWords = new Set(["a", "an", "app", "action", "deeplink", "launch", "open", "page", "the", "to", "with"]);

function compactAction(app: string, heading: string): string | null {
  if (new RegExp(`\\b(?:launch|open)\\s+${app.toLocaleLowerCase("en-US").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+app)?\\b`, "i").test(heading)) return null;
  const appWords = new Set(app.toLocaleLowerCase("en-US").match(/[a-z0-9]+/g) ?? []);
  const words = (heading.match(/[A-Za-z0-9+#.]+/g) ?? [])
    .map((word) => word.toLocaleLowerCase("en-US"))
    .filter((word) => !actionStopWords.has(word) && !appWords.has(word) && word !== "shared");
  if (!words.length) return null;
  const replacements: Record<string, string> = {
    "chat phone": "chat phone number",
    conversation: "conversation link",
    video: "video link",
    profile: "profile link",
    channel: "channel link",
    title: "title link",
  };
  const phrase = words.join(" ");
  return `${app} ${replacements[phrase] ?? phrase}`;
}

export async function generateCatalog(sourceRepo: string): Promise<CatalogManifest> {
  const repositoryRoot = await validateSourceRepository(sourceRepo);
  const pubspecText = await fs.readFile(path.join(repositoryRoot, "pubspec.yaml"), "utf8");
  const docs = await readDocs(repositoryRoot);
  const apps = docs.filter((doc) => !doc.isStore);
  const stores = docs.filter((doc) => doc.isStore);
  const topics = parseTopics(pubspecText);
  const queries = new Map<string, QueryDefinition>();

  for (const [area, terms] of Object.entries(FIXED_CORE)) {
    for (const term of terms) {
      await addQuery(queries, {
        query: term,
        lane: "compact-core",
        productArea: area,
        expressionType: "raw",
        profiles: ["pulse", "full"],
        source: { type: "fixed-catalog", location: STABLE_FIXED_CATALOG_SOURCE, derivation: `Clean-room compact core: ${area}` },
        productFit: NOISE_TERMS.has(term) ? "medium" : "high",
      });
    }
  }

  for (const expression of SDK_SEARCHES) {
    await addQuery(queries, {
      query: expression, lane: "structured", productArea: "sdk-filter", expressionType: "sdk-filter",
      profiles: ["pulse", "full"],
      source: { type: "pubdev-syntax", location: "https://pub.dev/help/search", derivation: "Explicit sdk:flutter expression" },
    });
  }
  for (const topic of topics) {
    await addQuery(queries, {
      query: `topic:${topic}`, lane: "structured", productArea: "topic", expressionType: "topic-filter",
      profiles: ["pulse", "full"],
      source: { type: "repo", location: "pubspec.yaml", derivation: `Published topic candidate: ${topic}` },
    });
  }

  const heroKeys = new Set(HERO_APPS.map(normalize));
  for (const app of apps) {
    const profiles: Array<"pulse" | "full"> = heroKeys.has(normalize(app.name)) ? ["pulse", "full"] : ["full"];
    for (const suffix of ["", " link", " deeplink", " deep link"]) {
      await addQuery(queries, {
        query: `${app.name}${suffix}`, lane: "provider", productArea: "app", expressionType: "raw", profiles,
        source: { type: "repo", location: app.location, derivation: "Supported-app four-query matrix" },
        tags: { provider: app.name },
      });
    }
    for (const capability of documentedCapabilities(app.headings)) {
      await addQuery(queries, {
        query: `${app.name} ${capability}`, lane: "navigation", productArea: "maps-navigation", expressionType: "raw", profiles: ["full"],
        source: { type: "repo", location: app.location, derivation: `Documented navigation capability: ${capability}` },
        tags: { provider: app.name, capability },
      });
    }
    for (const heading of app.headings) {
      const action = compactAction(app.name, heading);
      if (!action) continue;
      await addQuery(queries, {
        query: action, lane: "action", productArea: "provider-action", expressionType: "raw", profiles: ["full"],
        source: { type: "repo", location: app.location, derivation: `Compact action from heading: ${heading}` },
        tags: { provider: app.name, action: heading },
      });
    }
  }

  for (const store of stores) {
    for (const suffix of ["", " link", " deeplink", " deep link", " launcher", " redirect"]) {
      await addQuery(queries, {
        query: `${store.name}${suffix}`, lane: "store", productArea: "stores-fallbacks", expressionType: "raw", profiles: ["full"],
        source: { type: "repo", location: store.location, derivation: "Supported-store compact matrix" },
        tags: { store: store.name },
      });
    }
  }

  const catalogQueries = [...queries.values()].sort((left, right) => left.lane.localeCompare(right.lane) || normalize(left.query).localeCompare(normalize(right.query)));
  const catalogVersion = await catalogHash(catalogQueries);
  for (const query of catalogQueries) query.catalog_version = catalogVersion;
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const navigationProviders = apps.filter((app) => documentedCapabilities(app.headings).length).map((app) => app.name);
  const manifest: CatalogManifest = {
    schema_version: 3,
    catalog_revision: CATALOG_REVISION,
    catalog_version: catalogVersion,
    package: PACKAGE_NAME,
    generated_at: new Date().toISOString(),
    source_commit: sourceCommit,
    source_url: `https://github.com/DeepLinkX/DeeplinkX/tree/${sourceCommit}`,
    product: {
      repository_version: parseScalar(pubspecText, "version"),
      repository_description: parseScalar(pubspecText, "description"),
      topics,
      apps: apps.map((app) => app.name),
      stores: stores.map((store) => store.name),
      navigation_providers: navigationProviders,
      hero_apps: apps.filter((app) => heroKeys.has(normalize(app.name))).map((app) => app.name).sort(),
      new_providers: [],
    },
    selection: {
      profiles: {
        pulse: { depth: 10, description: "Fixed 58 searches plus hero/new-provider four-query matrix" },
        full: { depth: 100, description: "Complete compact app/store/action/navigation catalog" },
      },
      profile_counts: {
        pulse: catalogQueries.filter((query) => query.profiles.includes("pulse")).length,
        full: catalogQueries.filter((query) => query.profiles.includes("full")).length,
      },
      fixed_raw_count: 48,
      fixed_structured_count: 10,
    },
    queries: catalogQueries,
    counts: { queries: catalogQueries.length, apps: apps.length, stores: stores.length, navigation_providers: navigationProviders.length },
  };
  return validateCatalog(manifest);
}

export async function writeCatalog(catalog: CatalogManifest, outputPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const arguments_ = parseGeneratorArguments(process.argv.slice(2));
  const catalog = await generateCatalog(arguments_.sourceRepo);
  await writeCatalog(catalog, arguments_.outputPath);
  process.stdout.write(`Wrote ${catalog.counts.queries} queries (${catalog.selection.profile_counts.pulse} pulse, ${catalog.selection.profile_counts.full} full) to ${arguments_.outputPath}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
