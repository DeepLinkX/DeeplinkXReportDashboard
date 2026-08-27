import { describe, expect, it, vi } from "vitest";
import {
  MUTABLE_CACHE_TAG,
  canonicalPublicRequest,
  purgePublicCacheTags,
  runCacheTag,
  withPublicCache,
} from "../src/worker/cache.js";

function canonical(path: string, init?: RequestInit): Request | null {
  return canonicalPublicRequest(new Request(`https://visibility.example${path}`, init));
}

describe("public API cache keys", () => {
  it("normalizes parameter order, defaults, trailing slashes, and ignored parameters", () => {
    const first = canonical("/api/v1/history/events/?limit=50&profile=pulse&to=2026-08-27&from=2026-07-01&utm_source=test");
    const second = canonical("/api/v1/history/events?from=2026-07-01&to=2026-08-27");
    expect(first?.url).toBe(second?.url);
    expect(first?.url).toBe("https://visibility.example/api/v1/history/events?from=2026-07-01&to=2026-08-27");
  });

  it("normalizes bounded limits and equivalent outcome sets", () => {
    expect(canonical("/api/v1/runs?limit=999")?.url).toBe("https://visibility.example/api/v1/runs?limit=100");
    expect(canonical("/api/v1/history/events?outcome=lost_visibility,improved,found,dropped")?.url)
      .toBe("https://visibility.example/api/v1/history/events");
  });

  it("preserves every response-affecting query and keeps distinct queries isolated", () => {
    const map = canonical("/api/v1/runs/run-1/queries?provider=Google+Maps&lane=navigation&product_area=maps-navigation");
    const otherProvider = canonical("/api/v1/runs/run-1/queries?provider=Apple+Maps&lane=navigation&product_area=maps-navigation");
    expect(map?.url).toBe("https://visibility.example/api/v1/runs/run-1/queries?lane=navigation&provider=Google+Maps&product_area=maps-navigation");
    expect(otherProvider?.url).not.toBe(map?.url);
    expect(canonical("/api/v1/history/events?cursor=abc&limit=250&outcome=all")?.url)
      .toBe("https://visibility.example/api/v1/history/events?outcome=all&limit=250&cursor=abc");
  });

  it("strips caller credentials and excludes private, health, and non-GET routes", () => {
    const request = canonical("/api/v1/summary", { headers: { authorization: "Bearer secret", cookie: "session=secret" } });
    expect(request?.headers.get("authorization")).toBeNull();
    expect(request?.headers.get("cookie")).toBeNull();
    expect(canonical("/api/v1/health")).toBeNull();
    expect(canonical("/api/v1/admin/runs")).toBeNull();
    expect(canonical("/api/v1/summary", { method: "POST" })).toBeNull();
  });
});

describe("public API cache policies", () => {
  it("applies live, mutable, and immutable browser and edge TTLs", () => {
    const live = withPublicCache(Response.json({ ok: true }), "live", [MUTABLE_CACHE_TAG]);
    const mutable = withPublicCache(Response.json({ ok: true }), "mutable", [MUTABLE_CACHE_TAG]);
    const immutable = withPublicCache(Response.json({ ok: true }), "immutable");

    expect(live.headers.get("cache-control")).toBe("public, max-age=30");
    expect(live.headers.get("cloudflare-cdn-cache-control")).toBe("public, max-age=30");
    expect(live.headers.get("cache-tag")).toBe(MUTABLE_CACHE_TAG);
    expect(mutable.headers.get("cache-control")).toBe("public, max-age=60");
    expect(mutable.headers.get("cloudflare-cdn-cache-control"))
      .toBe("public, max-age=300, stale-while-revalidate=60");
    expect(immutable.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("never makes errors or explicit no-store responses cacheable", () => {
    const error = withPublicCache(Response.json({ error: "missing" }, {
      status: 404,
      headers: { "cache-control": "no-store" },
    }), "immutable", [MUTABLE_CACHE_TAG]);
    expect(error.headers.get("cache-control")).toBe("no-store");
    expect(error.headers.get("cache-tag")).toBeNull();
  });

  it("creates bounded, valid run tags", () => {
    expect(runCacheTag("run id/with unsafe?characters")).toBe("visibility:run:run_id_with_unsafe_characters");
    expect(runCacheTag("x".repeat(200))).toHaveLength("visibility:run:".length + 100);
  });
});

describe("public API cache invalidation", () => {
  it("deduplicates tags and reports purge rejection without throwing", async () => {
    const purge = vi.fn(async () => ({ success: false, errors: [{ code: 1015, message: "rate limited" }] }));
    const outcome = await purgePublicCacheTags({ purge }, [MUTABLE_CACHE_TAG, MUTABLE_CACHE_TAG, ""]);
    expect(purge).toHaveBeenCalledWith([MUTABLE_CACHE_TAG]);
    expect(outcome).toEqual({ success: false, detail: "1015: rate limited" });
  });

  it("treats thrown purge failures as bounded fallback events", async () => {
    const outcome = await purgePublicCacheTags({ purge: async () => { throw new Error("unavailable"); } }, [MUTABLE_CACHE_TAG]);
    expect(outcome).toEqual({ success: false, detail: "unavailable" });
  });
});
