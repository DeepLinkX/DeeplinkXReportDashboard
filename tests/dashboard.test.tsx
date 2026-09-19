import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetricChart } from "../src/dashboard/charts.js";
import { CompetitorSections } from "../src/dashboard/App.js";
import type { Competitor, CompetitorClassificationSummary } from "../src/dashboard/api-client.js";

describe("accessible package metric chart", () => {
  it("keeps null observations as gaps and exposes keyboard and table equivalents", () => {
    const html = renderToStaticMarkup(<MetricChart
      labels={["2026-07-01", "2026-07-06", "2026-07-10", "2026-07-19"]}
      values={[436, null, 925, 1124]}
      label="Rolling 30-day downloads"
      color="#30d5f2"
    />);
    expect(html.match(/data-segment="observed"/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(3);
    expect(html).toContain("missing observations are gaps");
    expect(html).toContain("Rolling 30-day downloads values by UTC report date");
    expect(html).toContain("Not captured");
  });
});

function competitor(overrides: Partial<Competitor>): Competitor {
  return {
    package_name: "map_launcher",
    occurrence_count: 133,
    best_rank: 1,
    median_rank: 2,
    category: "map/navigation launcher",
    classification_status: "complete",
    relationship: "direct",
    capability_category: "map/navigation launcher",
    classifier_version: "metadata-v1",
    published_version: "6.0.0",
    published_description: "Launch installed maps.",
    published_topics: [],
    metadata_captured_at: "2026-09-02T00:00:00Z",
    rationale: "Published metadata explicitly describes launching maps.",
    matched_terms: ["map launcher"],
    relevant_occurrence_count: 80,
    relevant_best_rank: 1,
    relevant_median_rank: 3,
    ...overrides,
  };
}

const classification: CompetitorClassificationSummary = {
  status: "complete",
  classifier_version: "metadata-v1",
  raw_competitor_count: 2,
  candidate_count: 2,
  complete_count: 2,
  failed_count: 0,
  pending_count: 0,
  relationship_counts: { direct: 1, adjacent: 0, noise: 1, unknown: 0 },
};

describe("competitor presentation", () => {
  it("shows direct and adjacent groups while collapsing search noise by default", () => {
    const html = renderToStaticMarkup(<CompetitorSections
      classification={classification}
      competitors={[
        competitor({}),
        competitor({
          package_name: "iconify_flutter_plus",
          relationship: "noise",
          capability_category: "other",
          rationale: "Published metadata describes an icon package.",
          relevant_occurrence_count: 0,
          relevant_best_rank: null,
          relevant_median_rank: null,
        }),
      ]}
    />);
    expect(html).toContain("Direct competitors");
    expect(html).toContain("Adjacent ecosystem");
    expect(html).toContain("Search noise and unknown packages (1)");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html.indexOf("map_launcher")).toBeLessThan(html.indexOf("<details"));
    expect(html.indexOf("iconify_flutter_plus")).toBeGreaterThan(html.indexOf("<details"));
  });

  it("explains when migrated reports lack competitor package evidence", () => {
    const html = renderToStaticMarkup(<CompetitorSections
      competitors={[]}
      classification={{
        ...classification,
        status: "unavailable",
        raw_competitor_count: 0,
        candidate_count: 0,
        complete_count: 0,
        relationship_counts: { direct: 0, adjacent: 0, noise: 0, unknown: 0 },
        reason: "No preserved positions.",
      }}
    />);
    expect(html).toContain("Historical competitor evidence unavailable");
    expect(html).toContain("No preserved positions.");
  });
});
