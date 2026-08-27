import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMigrationArguments } from "../scripts/migrate-legacy.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

describe("standalone project boundaries", () => {
  it("owns dashboard assets without reaching into the Dart package", async () => {
    const app = await fs.readFile(path.join(projectRoot, "src", "dashboard", "App.tsx"), "utf8");
    expect(app).toContain('from "./assets/deeplink_x_logo.jpg"');
    expect(app).not.toContain("../../../../images");
    await expect(fs.stat(path.join(projectRoot, "src", "dashboard", "assets", "deeplink_x_logo.jpg")))
      .resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("publishes the catalog from the standalone GitHub repository", async () => {
    const configuration = JSON.parse(await fs.readFile(path.join(projectRoot, "wrangler.jsonc"), "utf8"));
    expect(configuration.vars.CATALOG_URL)
      .toBe("https://raw.githubusercontent.com/DeepLinkX/DeeplinkXReportDashboard/main/catalog/catalog-v3.json");
    const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
    expect(packageJson.repository.url).toContain("DeepLinkX/DeeplinkXReportDashboard.git");
  });

  it("keeps legacy migration output outside the project", () => {
    const outside = path.join(os.tmpdir(), "deeplinkx-legacy-output");
    expect(parseMigrationArguments(["--source-dir", "/tmp/legacy", "--output-dir", outside]))
      .toMatchObject({ sourceRoot: "/tmp/legacy", outputRoot: outside });
    expect(() => parseMigrationArguments([
      "--source-dir", "/tmp/legacy",
      "--output-dir", path.join(projectRoot, "migration-output"),
    ])).toThrow(/must stay outside/);
  });
});
