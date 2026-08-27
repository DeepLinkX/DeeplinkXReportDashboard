import { afterEach, describe, expect, it, vi } from "vitest";
import { recommendation } from "../src/worker/reports.js";
import { retryDelay } from "../src/worker/scanner.js";

function query(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "run", query_id: "q", query: "map launcher", lane: "compact-core",
    product_area: "maps-navigation", expression_type: "raw", product_fit: "high",
    tags_json: "{}", sources_json: "[]", definition_hash: "hash", requested_depth: 10,
    actual_depth: 10, rank: null, pages_scanned: 1, exhausted: 0, status: "complete",
    retry_count: 0, packages_json: "[]", error_code: null, ...overrides,
  };
}

describe("Worker evidence logic", () => {
  afterEach(() => vi.restoreAllMocks());

  it("honors Retry-After seconds and caps HTTP dates", () => {
    expect(retryDelay(new Response("", { headers: { "retry-after": "37" } }), 1)).toBe(37);
    expect(retryDelay(new Response("", { headers: { "retry-after": new Date(Date.now() + 86_400_000).toUTCString() } }), 1)).toBe(43_200);
  });

  it("uses capped exponential retry with jitter when Retry-After is absent", () => {
    vi.spyOn(Math, "random").mockReturnValue(.5);
    expect(retryDelay(null, 1)).toBe(20);
    expect(retryDelay(null, 20)).toBe(3600);
  });

  it("classifies recommendations from rank and metadata evidence", () => {
    expect(recommendation(query({ rank: 2 }) as never, "", "").class).toBe("protect");
    expect(recommendation(query() as never, "deeplink_x", "deeplink_x").class).toBe("metadata gap");
    expect(recommendation(query() as never, "deeplink_x map launcher", "deeplink_x map launcher").class).toBe("authority gap");
    expect(recommendation(query({ lane: "provider", query: "WhatsApp chat phone number" }) as never, "", "deeplink_x").class).toBe("capability gap");
    expect(recommendation(query({ query: "open app", product_fit: "medium" }) as never, "", "").class).toBe("noise");
  });
});
