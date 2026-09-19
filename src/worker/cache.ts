export const MUTABLE_CACHE_TAG = "visibility:mutable";
import { DIRECTORY_FILTERS } from "../shared/intelligence.js";

export type PublicCachePolicy = "live" | "mutable" | "immutable";

const CACHE_HEADERS: Record<PublicCachePolicy, { browser: string; edge: string }> = {
  live: {
    browser: "public, max-age=30",
    edge: "public, max-age=30",
  },
  mutable: {
    browser: "public, max-age=60",
    edge: "public, max-age=300, stale-while-revalidate=60",
  },
  immutable: {
    browser: "public, max-age=31536000, immutable",
    edge: "public, max-age=31536000, immutable",
  },
};

const HISTORY_OUTCOMES = [
  "improved",
  "dropped",
  "found",
  "lost_visibility",
  "unchanged",
  "not_visible",
  "withheld",
] as const;
const DEFAULT_HISTORY_OUTCOMES = HISTORY_OUTCOMES.slice(0, 4);
const COMPETITOR_RELATIONSHIPS = ["direct", "adjacent", "noise", "unknown"] as const;

function normalizedPath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function appendRaw(source: URLSearchParams, target: URLSearchParams, name: string): void {
  const value = source.get(name);
  if (value !== null && value !== "") target.set(name, value);
}

function appendBoundedInteger(
  source: URLSearchParams,
  target: URLSearchParams,
  name: string,
  defaultValue: number,
  maximum: number,
): void {
  const raw = source.get(name);
  if (raw === null || raw === "") return;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    target.set(name, raw);
    return;
  }
  const normalized = Math.min(maximum, Math.max(1, parsed));
  if (normalized !== defaultValue) target.set(name, String(normalized));
}

function appendHistoryProfile(source: URLSearchParams, target: URLSearchParams): void {
  const profile = source.get("profile");
  if (profile === null || profile === "pulse") return;
  target.set("profile", profile);
}

function appendHistoryOutcome(source: URLSearchParams, target: URLSearchParams): void {
  const raw = source.get("outcome");
  if (!raw) return;
  if (raw === "all") {
    target.set("outcome", raw);
    return;
  }
  const values = [...new Set(raw.split(",").filter(Boolean))];
  if (!values.length || values.some((value) => !HISTORY_OUTCOMES.includes(value as typeof HISTORY_OUTCOMES[number]))) {
    target.set("outcome", raw);
    return;
  }
  const ordered = HISTORY_OUTCOMES.filter((value) => values.includes(value));
  if (ordered.length === DEFAULT_HISTORY_OUTCOMES.length
    && ordered.every((value, index) => value === DEFAULT_HISTORY_OUTCOMES[index])) return;
  target.set("outcome", ordered.join(","));
}

function appendCompetitorRelationships(source: URLSearchParams, target: URLSearchParams): void {
  const raw = source.get("relationship");
  if (!raw || raw === "all") return;
  const values = [...new Set(raw.split(",").filter(Boolean))];
  if (!values.length || values.some((value) => !COMPETITOR_RELATIONSHIPS.includes(value as typeof COMPETITOR_RELATIONSHIPS[number]))) {
    target.set("relationship", raw);
    return;
  }
  target.set("relationship", COMPETITOR_RELATIONSHIPS.filter((value) => values.includes(value)).join(","));
}

function publicCacheUrl(requestUrl: URL): URL | null {
  const path = normalizedPath(requestUrl.pathname);
  const source = requestUrl.searchParams;
  const url = new URL(requestUrl.origin);
  url.pathname = path;

  if (path === "/api/v1/summary") return url;
  if (path === "/api/v1/runs") {
    const profile = source.get("profile");
    if (profile === "pulse" || profile === "full" || profile === "legacy-mixed") url.searchParams.set("profile", profile);
    appendBoundedInteger(source, url.searchParams, "limit", 30, 100);
    return url;
  }
  if (path === "/api/v1/stats") {
    appendRaw(source, url.searchParams, "profile");
    appendRaw(source, url.searchParams, "canonical");
    appendRaw(source, url.searchParams, "from");
    appendRaw(source, url.searchParams, "to");
    return url;
  }
  if (path === "/api/v1/history/summary") {
    appendHistoryProfile(source, url.searchParams);
    appendRaw(source, url.searchParams, "from");
    appendRaw(source, url.searchParams, "to");
    return url;
  }
  if (path === "/api/v1/history/events") {
    appendHistoryProfile(source, url.searchParams);
    appendRaw(source, url.searchParams, "from");
    appendRaw(source, url.searchParams, "to");
    appendHistoryOutcome(source, url.searchParams);
    appendBoundedInteger(source, url.searchParams, "limit", 50, 250);
    appendRaw(source, url.searchParams, "cursor");
    return url;
  }
  if (path === "/api/v1/compare") {
    appendRaw(source, url.searchParams, "before");
    appendRaw(source, url.searchParams, "after");
    return url;
  }
  if (path === "/api/v1/competitors") {
    const defaults: Record<string,string> = {view:"direct",sort:"downloads",order:"desc",page:"1",limit:"50"};
    for (const key of DIRECTORY_FILTERS) {
      let value=source.get(key)?.trim();
      if (value && ["page","limit","age_months"].includes(key) && /^\d+$/.test(value)) value=String(Number(value));
      if (value && value!==defaults[key]) url.searchParams.set(key,value);
    }
    return url;
  }
  if (/^\/api\/v1\/competitors\/[a-z][a-z0-9_]*$/.test(path)) return url;
  if (path === "/api/v1/legacy" || /^\/api\/v1\/legacy\/[^/]+$/.test(path)) return url;
  if (/^\/api\/v1\/runs\/[^/]+$/.test(path)) return url;
  if (/^\/api\/v1\/runs\/[^/]+\/queries$/.test(path)) {
    appendRaw(source, url.searchParams, "lane");
    appendRaw(source, url.searchParams, "provider");
    appendRaw(source, url.searchParams, "product_area");
    return url;
  }
  if (/^\/api\/v1\/queries\/[^/]+\/history$/.test(path)) {
    const profile = source.get("profile");
    if (profile === "pulse" || profile === "full") url.searchParams.set("profile", profile);
    return url;
  }
  if (/^\/api\/v1\/runs\/[^/]+\/competitors$/.test(path)) {
    appendCompetitorRelationships(source, url.searchParams);
    return url;
  }
  if (/^\/api\/v1\/runs\/[^/]+\/recommendations$/.test(path)) return url;
  if (/^\/api\/v1\/exports\/[^/]+\/(?:markdown|csv|json)$/.test(path)) return url;
  return null;
}

/** Build the trusted, minimal request used as the PublicAPI cache key. */
export function canonicalPublicRequest(request: Request): Request | null {
  if (request.method !== "GET") return null;
  const url = publicCacheUrl(new URL(request.url));
  if (!url) return null;
  return new Request(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
}

export function runCacheTag(runId: string): string {
  const safeId = runId.replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 100);
  return `visibility:run:${safeId}`;
}

/** Attach browser and Workers Cache policy only to successful public responses. */
export function withPublicCache(
  response: Response,
  policy: PublicCachePolicy,
  tags: string[] = [],
): Response {
  if (!response.ok || response.headers.get("cache-control")?.includes("no-store")) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", CACHE_HEADERS[policy].browser);
  headers.set("cloudflare-cdn-cache-control", CACHE_HEADERS[policy].edge);
  const uniqueTags = [...new Set(tags.filter(Boolean))];
  if (uniqueTags.length) headers.set("cache-tag", uniqueTags.join(","));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export interface PublicCachePurger {
  purge(tags: string[]): Promise<CachePurgeResult>;
}

export interface PublicCachePurgeOutcome {
  success: boolean;
  detail?: string;
}

/** Normalize purge calls so runtime failures can be recorded without undoing durable writes. */
export async function purgePublicCacheTags(
  purger: PublicCachePurger,
  tags: string[],
): Promise<PublicCachePurgeOutcome> {
  const uniqueTags = [...new Set(tags.filter(Boolean))];
  if (!uniqueTags.length) return { success: true };
  try {
    const result = await purger.purge(uniqueTags);
    if (result.success) return { success: true };
    return {
      success: false,
      detail: result.errors.map((error) => `${error.code}: ${error.message}`).join("; ") || "Workers Cache rejected the purge.",
    };
  } catch (error) {
    return { success: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
