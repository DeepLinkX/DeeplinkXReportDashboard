import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetricChart } from "../src/dashboard/charts.js";

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
