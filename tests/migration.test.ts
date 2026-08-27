import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { normalize, sha256Hex, validateCatalog } from "../src/shared/catalog.js";
import { packageSnapshot, parseVisibility } from "../scripts/migrate-legacy.js";

describe("legacy normalization", () => {
  it("expands app matrices and excludes inherited baseline-only rows", async () => {
    const catalog = await validateCatalog(JSON.parse(await readFile(new URL("../catalog/catalog-v3.json", import.meta.url), "utf8")));
    const content = `# pub.dev Keyword Visibility Report

Generated: 2026-08-27

## Current Published Package Signals

pub.dev reports \`deeplink_x\` latest as \`1.4.10\`, published on \`2026-08-25T14:49:12.752778Z\`.

| Signal | Value |
| --- | ---: |
| Pub points | 160 / 160 |
| Likes | 13 |
| 30-day downloads | 1724 |
| Topics | \`deeplink\`, \`maps\` |

## App-Specific Competitor Matrix

| App | Plain app query | App link query | App deeplink query | Open from Flutter | Main packages |
| --- | ---: | ---: | ---: | ---: | --- |
| WhatsApp | not in top 10 | #2 p1 | #1 p1 | #2 p1 | packages |

### Core Deeplink Terms

| Keyword | Rank | Packages |
| --- | ---: | --- |
| \`deep link\` | baseline-only (#4 p1) | baseline only |
| \`map launch\` | #6 p1 | packages |
`;
    const payload = await parseVisibility(
      "pubdev_keyword_visibility_report_2026-08-27.md",
      content,
      await sha256Hex(content),
      new Map(catalog.queries.map((query) => [normalize(query.query), query])),
      catalog.product.repository_description,
    );
    expect(payload.run?.rows.map((row) => row.query)).toEqual(expect.arrayContaining(["WhatsApp", "WhatsApp link", "WhatsApp deeplink", "open WhatsApp from Flutter", "map launch"]));
    expect(payload.run?.rows.some((row) => row.query === "deep link")).toBe(false);
    expect(payload.run?.ignored_baseline_rows).toBe(1);
    expect(payload.run?.rows.find((row) => row.query === "WhatsApp deeplink")?.rank).toBe(1);
    expect(payload.run?.rows.every((row) => row.actual_depth === 10)).toBe(true);
  });

  it("captures historical package signals without inventing missing values", () => {
    const snapshot = packageSnapshot("pub.dev reports `deeplink_x` latest as `1.4.0`.\n| Likes | 13 |\n| 30-day downloads | 1,124 |", "repo description");
    expect(snapshot.published_version).toBe("1.4.0");
    expect(snapshot.likes).toBe(13);
    expect(snapshot.downloads_30d).toBe(1124);
    expect(snapshot.points).toBeNull();
  });
});
