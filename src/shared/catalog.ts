import type {
  CatalogManifest,
  ExpressionType,
  ProductFit,
  QueryDefinition,
  QuerySource,
} from "./types.js";

export const SCHEMA_VERSION = 3 as const;
export const CATALOG_REVISION = "clean-room-v1";
export const PACKAGE_NAME = "deeplink_x";
export const PROFILE_DEPTH = { pulse: 10, full: 100 } as const;
export const PROFILE_BUDGET = { pulse: 120, full: 750 } as const;
export const HERO_APPS = [
  "WhatsApp",
  "Telegram",
  "Instagram",
  "YouTube",
  "Google Maps",
  "Waze",
] as const;

export const FIXED_CORE = {
  category: [
    "deeplink", "deep link", "deep-link", "deeplinks", "deep links", "deep-links",
    "deep linking", "app deeplink", "app deep link", "external deeplink",
    "external deep link", "outbound deeplink",
  ],
  "app-launching": [
    "app launcher", "external app launcher", "application launcher", "app launch",
    "launch app", "open app", "native app launcher", "intent launcher",
  ],
  "maps-navigation": [
    "map deeplink", "map deep link", "map deep-link", "maps deeplink", "maps deep link",
    "map launch", "map launcher", "maps launcher", "navigation deeplink",
    "navigation launcher", "map navigation", "map directions",
  ],
  "stores-fallbacks": [
    "store deeplink", "store deep link", "store launcher", "store redirect",
    "app store launcher", "app store redirect", "deeplink fallback", "store fallback",
    "web fallback", "app fallback",
  ],
  "features-comparisons": [
    "typed deeplink", "type safe deeplink", "check app installed",
    "url_launcher alternative", "map_launcher alternative", "external_app_launcher alternative",
  ],
} as const;

export const SDK_SEARCHES = [
  "sdk:flutter deeplink",
  "sdk:flutter deep link",
  "sdk:flutter app launcher",
  "sdk:flutter map launcher",
  "sdk:flutter store redirect",
] as const;

export const NOISE_TERMS = new Set([
  "open app", "launch app", "app launch", "application launcher", "deeplink", "deep link",
  "deep-link", "deeplinks", "deep links", "deep-links",
]);

export function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function semanticText(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function stableQueryId(query: string, expressionType: ExpressionType): Promise<string> {
  return `q_${(await sha256Hex(`${expressionType}\0${normalize(query)}`)).slice(0, 14)}`;
}

export async function catalogHash(queries: QueryDefinition[]): Promise<string> {
  const material = [...queries]
    .sort((left, right) => left.query_id.localeCompare(right.query_id))
    .map((item) => ({
      query_id: item.query_id,
      query: item.query,
      lane: item.lane,
      product_area: item.product_area,
      expression_type: item.expression_type,
      profiles: item.profiles,
      product_fit: item.product_fit,
    }));
  return `${CATALOG_REVISION}-${(await sha256Hex(stableJson(material))).slice(0, 16)}`;
}

export async function addQuery(
  queries: Map<string, QueryDefinition>,
  input: {
    query: string;
    lane: string;
    productArea: string;
    expressionType: ExpressionType;
    profiles: Array<"pulse" | "full">;
    source: QuerySource;
    productFit?: ProductFit;
    tags?: Record<string, string>;
  },
): Promise<void> {
  const query = input.query.trim().replace(/\s+/g, " ");
  const key = normalize(query);
  if (!key) return;
  const current = queries.get(key);
  if (!current) {
    queries.set(key, {
      query_id: await stableQueryId(query, input.expressionType),
      query,
      lane: input.lane,
      product_area: input.productArea,
      expression_type: input.expressionType,
      profiles: [...new Set(input.profiles)].sort() as Array<"pulse" | "full">,
      sources: [input.source],
      product_fit: input.productFit ?? "high",
      tags: input.tags ?? {},
      catalog_version: "pending",
    });
    return;
  }
  current.profiles = [...new Set([...current.profiles, ...input.profiles])].sort() as Array<"pulse" | "full">;
  if (current.lane !== input.lane) current.lane = "cross-cutting";
  if (current.product_area !== input.productArea) current.product_area = "cross-cutting";
  if (!current.sources.some((source) => stableJson(source) === stableJson(input.source))) {
    current.sources.push(input.source);
  }
  const fitOrder = { low: 0, medium: 1, high: 2 };
  const nextFit = input.productFit ?? "high";
  if (fitOrder[nextFit] > fitOrder[current.product_fit]) current.product_fit = nextFit;
  current.tags = { ...current.tags, ...(input.tags ?? {}) };
}

export async function validateCatalog(manifest: unknown): Promise<CatalogManifest> {
  if (!manifest || typeof manifest !== "object") throw new Error("Catalog must be an object.");
  const candidate = manifest as Partial<CatalogManifest>;
  if (candidate.schema_version !== SCHEMA_VERSION) throw new Error("Catalog schema must be v3.");
  if (candidate.catalog_revision !== CATALOG_REVISION) throw new Error("Catalog revision is unsupported.");
  if (candidate.package !== PACKAGE_NAME) throw new Error("Catalog package must be deeplink_x.");
  if (!Array.isArray(candidate.queries)) throw new Error("Catalog queries are missing.");
  const ids = new Set<string>();
  const normalized = new Set<string>();
  for (const query of candidate.queries) {
    if (!query.query_id || !query.query || !query.expression_type) throw new Error("Catalog query is incomplete.");
    if (ids.has(query.query_id)) throw new Error(`Duplicate query ID: ${query.query_id}`);
    const key = normalize(query.query);
    if (normalized.has(key)) throw new Error(`Duplicate normalized query: ${query.query}`);
    if (/\b(?:how (?:do|to)|from flutter|using flutter)\b/i.test(query.query)) {
      throw new Error(`Sentence-style pub.dev query is forbidden: ${query.query}`);
    }
    if (query.expression_type !== "sdk-filter" && /\bflutter\b/i.test(query.query)) {
      throw new Error(`Redundant Flutter suffix is forbidden: ${query.query}`);
    }
    ids.add(query.query_id);
    normalized.add(key);
  }
  const fixedRaw = candidate.queries.filter((query) => query.lane === "compact-core").length;
  const structured = candidate.queries.filter((query) => query.lane === "structured").length;
  if (fixedRaw !== 48 || structured !== 10) throw new Error("Catalog must contain 48 compact and 10 structured searches.");
  const computed = await catalogHash(candidate.queries);
  if (computed !== candidate.catalog_version) throw new Error("Catalog hash does not match its definitions.");
  const pulseCount = candidate.queries.filter((query) => query.profiles.includes("pulse")).length;
  const fullCount = candidate.queries.filter((query) => query.profiles.includes("full")).length;
  if (pulseCount > PROFILE_BUDGET.pulse || fullCount > PROFILE_BUDGET.full) {
    throw new Error(`Catalog exceeds Free-tier budgets (${pulseCount} pulse, ${fullCount} full).`);
  }
  return candidate as CatalogManifest;
}
