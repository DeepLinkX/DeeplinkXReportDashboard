import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  FIXED_CORE,
  PROFILE_BUDGET,
  SDK_SEARCHES,
  catalogHash,
  normalize,
  stableQueryId,
  validateCatalog,
} from "../src/shared/catalog.js";
import type { CatalogManifest } from "../src/shared/types.js";

async function catalog(): Promise<CatalogManifest> {
  return validateCatalog(JSON.parse(await readFile(new URL("../catalog/catalog-v3.json", import.meta.url), "utf8")));
}

describe("schema-v3 catalog", () => {
  it("contains the fixed compact and structured searches", async () => {
    const value = await catalog();
    const compact = value.queries.filter((query) => query.lane === "compact-core").map((query) => query.query);
    const structured = value.queries.filter((query) => query.lane === "structured").map((query) => query.query);
    expect(compact).toHaveLength(48);
    expect(new Set(compact)).toEqual(new Set(Object.values(FIXED_CORE).flat()));
    expect(structured).toHaveLength(10);
    expect(structured).toEqual(expect.arrayContaining([...SDK_SEARCHES, ...value.product.topics.map((topic) => `topic:${topic}`)]));
  });

  it("keeps both profiles bounded and sentence-free", async () => {
    const value = await catalog();
    expect(value.selection.profile_counts).toEqual({ pulse: 82, full: 414 });
    expect(value.selection.profile_counts.pulse).toBeLessThanOrEqual(PROFILE_BUDGET.pulse);
    expect(value.selection.profile_counts.full).toBeLessThanOrEqual(PROFILE_BUDGET.full);
    for (const query of value.queries) {
      expect(query.query).not.toMatch(/\b(?:how (?:do|to)|from flutter|using flutter)\b/i);
      if (query.expression_type !== "sdk-filter") expect(query.query).not.toMatch(/\bflutter\b/i);
      expect(query.sources.length).toBeGreaterThan(0);
    }
  });

  it("generates provider, store, and navigation matrices without duplicates", async () => {
    const value = await catalog();
    const normalized = value.queries.map((query) => normalize(query.query));
    expect(new Set(normalized).size).toBe(value.queries.length);
    expect(value.queries.filter((query) => query.tags.provider === "Mapy.com" && query.product_area === "app")).toHaveLength(4);
    for (const store of value.product.stores) expect(value.queries.filter((query) => query.tags.store === store)).toHaveLength(6);
    expect(value.queries.some((query) => query.lane === "navigation" && query.tags.capability === "coordinates")).toBe(true);
    expect(value.product.navigation_providers).not.toContain("Temu");
    expect(value.product.navigation_providers).not.toContain("Threads");
    expect(value.product.navigation_providers).not.toContain("Twitter");
    expect(value.product.navigation_providers).not.toContain("YouTube");
    expect(value.queries.some((query) => query.lane === "navigation" && query.tags.provider === "Temu")).toBe(false);
  });

  it("uses stable IDs and rejects catalog drift", async () => {
    const value = await catalog();
    const deepLink = value.queries.find((query) => query.query === "deep link")!;
    expect(deepLink.query_id).toBe(await stableQueryId("  DEEP   LINK ", "raw"));
    expect(await catalogHash(value.queries)).toBe(value.catalog_version);
    await expect(validateCatalog({ ...value, catalog_version: "tampered" })).rejects.toThrow(/hash/i);
  });

  it("rejects a priority profile that exceeds its Free-tier budget", async () => {
    const value = structuredClone(await catalog());
    const additions = value.queries.filter((query) => !query.profiles.includes("pulse")).slice(0, 39);
    for (const query of additions) query.profiles.push("pulse");
    value.catalog_version = await catalogHash(value.queries);
    await expect(validateCatalog(value)).rejects.toThrow(/budgets/i);
  });
});
