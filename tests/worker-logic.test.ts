import { afterEach, describe, expect, it, vi } from "vitest";
import { recommendation } from "../src/worker/reports.js";
import { retryDelay } from "../src/worker/scanner.js";
import { classifyCompetitor, relevantCompetitorMetrics } from "../src/worker/competitors.js";

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

  it("classifies competitors from published metadata instead of matched query families", () => {
    expect(classifyCompetitor({
      packageName: "iconify_flutter_plus",
      version: "1.0.4",
      description: "100+ open source icon sets for Flutter",
      topics: [],
    })).toMatchObject({ relationship: "noise", capabilityCategory: "other" });
    expect(classifyCompetitor({
      packageName: "flutter_dynamic_launcher_icon",
      version: "1.0.0",
      description: "Change your app launcher icon dynamically.",
      topics: ["icons"],
    })).toMatchObject({ relationship: "noise", capabilityCategory: "other" });
    expect(classifyCompetitor({
      packageName: "map_launcher",
      version: "6.0.0",
      description: "Find available maps installed on a device and launch them with directions.",
      topics: [],
    })).toMatchObject({ relationship: "direct", capabilityCategory: "map/navigation launcher" });
    expect(classifyCompetitor({
      packageName: "external_app_launcher",
      version: "4.0.4",
      description: "A Flutter plugin which helps you to open another app from your app",
      topics: [],
    })).toMatchObject({ relationship: "direct", capabilityCategory: "external app launcher" });
    expect(classifyCompetitor({
      packageName: "store_redirect",
      version: "2.0.4",
      description: "Redirect users to an app page in Google Play Store and Apple App Store.",
      topics: [],
    })).toMatchObject({ relationship: "direct", capabilityCategory: "store redirect and fallback" });
    expect(classifyCompetitor({
      packageName: "launchify",
      version: "1.0.8",
      description: "Widgets for launching WhatsApp, Maps, and social links with app checks.",
      topics: ["url-launcher"],
    })).toMatchObject({ relationship: "direct", capabilityCategory: "provider-specific app linking" });
    expect(classifyCompetitor({
      packageName: "url_launcher",
      version: "6.3.2",
      description: "Flutter plugin for launching a URL with phone, SMS, and email schemes.",
      topics: ["url-launcher"],
    })).toMatchObject({ relationship: "adjacent", capabilityCategory: "general URL launcher" });
    expect(classifyCompetitor({
      packageName: "app_links",
      version: "7.2.1",
      description: "Android App Links, Deep Links, iOS Universal Links and Custom URL schemes handler.",
      topics: ["app-links"],
    })).toMatchObject({ relationship: "adjacent", capabilityCategory: "inbound links/routing" });
    expect(classifyCompetitor({
      packageName: "structured_logger",
      version: "1.0.0",
      description: "Structured logging for Dart applications.",
      topics: ["logging"],
    })).toMatchObject({ relationship: "noise", capabilityCategory: "other" });
    expect(classifyCompetitor({
      packageName: "silicon_bridge",
      version: "1.0.0",
      description: "Utilities for embedded hardware.",
      topics: [],
    })).toMatchObject({ relationship: "unknown", capabilityCategory: "other" });
  });

  it("calculates relevant metrics only from capability-compatible query evidence", () => {
    const result = classifyCompetitor({
      packageName: "map_launcher",
      version: "6.0.0",
      description: "Map launcher for installed map applications.",
      topics: [],
    });
    expect(relevantCompetitorMetrics([
      { position: 4, query: "map launcher", lane: "compact-core", productArea: "maps-navigation", tags: {} },
      { position: 1, query: "Pinterest profile", lane: "action", productArea: "provider-action", tags: { provider: "Pinterest" } },
      { position: 7, query: "Waze directions", lane: "navigation", productArea: "app", tags: { provider: "Waze", capability: "directions" } },
    ], result)).toEqual({ occurrenceCount: 2, bestRank: 4, medianRank: 5.5 });
    expect(relevantCompetitorMetrics([
      { position: 1, query: "map launcher", lane: "compact-core", productArea: "maps-navigation", tags: {} },
    ], classifyCompetitor({ packageName: "icon_pack", version: null, description: "A set of icons", topics: [] })))
      .toEqual({ occurrenceCount: 0, bestRank: null, medianRank: null });
  });
});
