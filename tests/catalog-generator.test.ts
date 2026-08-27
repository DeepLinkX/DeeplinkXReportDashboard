import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STABLE_FIXED_CATALOG_SOURCE,
  generateCatalog,
  parseGeneratorArguments,
  validateSourceRepository,
} from "../scripts/generate-catalog.js";

const temporaryRoots: string[] = [];

async function productFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deeplinkx-catalog-source-"));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, "doc", "apps", "stores"), { recursive: true });
  await fs.writeFile(path.join(root, "pubspec.yaml"), [
    "name: deeplink_x",
    "version: 1.0.0",
    "description: Type-safe external app launching for Flutter.",
    "topics:",
    "  - deeplink",
    "  - launcher",
    "  - maps",
    "  - navigation",
    "  - url-schemes",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(root, "README.md"), "# DeeplinkX\n");
  await fs.writeFile(
    path.join(root, "doc", "apps", "google_maps.md"),
    "# Google Maps Deeplinks\n\n### View Map Action\n\n### Directions With Coordinates Action\n",
  );
  await fs.writeFile(
    path.join(root, "doc", "apps", "stores", "play_store.md"),
    "# Play Store Deeplinks\n\n### Open App Page Action\n",
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Catalog Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "catalog-test@example.invalid"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "test fixture"], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("standalone catalog generation", () => {
  it("requires an explicit DeeplinkX source repository", () => {
    expect(() => parseGeneratorArguments([])).toThrow(/requires --source-repo/);
    const parsed = parseGeneratorArguments(["--source-repo", "../deeplink_x", "--output", "/tmp/catalog.json"]);
    expect(parsed.sourceRepo).toBe(path.resolve("../deeplink_x"));
    expect(parsed.outputPath).toBe("/tmp/catalog.json");
  });

  it("rejects missing and dirty product evidence", async () => {
    await expect(validateSourceRepository("/path/that/does/not/exist")).rejects.toThrow(/does not exist/);
    const root = await productFixture();
    await fs.appendFile(path.join(root, "README.md"), "dirty\n");
    await expect(validateSourceRepository(root)).rejects.toThrow(/product evidence is dirty/);
  });

  it("rejects a different product repository even when evidence paths exist", async () => {
    const root = await productFixture();
    const pubspec = path.join(root, "pubspec.yaml");
    await fs.writeFile(pubspec, (await fs.readFile(pubspec, "utf8")).replace("name: deeplink_x", "name: another_package"));
    execFileSync("git", ["add", "pubspec.yaml"], { cwd: root });
    execFileSync("git", ["commit", "-m", "change package identity"], { cwd: root });
    await expect(validateSourceRepository(root)).rejects.toThrow(/must be the deeplink_x product repository/);
  });

  it("generates deterministic query definitions from a committed product checkout", async () => {
    const root = await productFixture();
    const first = await generateCatalog(root);
    const second = await generateCatalog(root);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

    expect(first.catalog_version).toBe(second.catalog_version);
    expect(first.queries).toEqual(second.queries);
    expect(first.selection.fixed_raw_count).toBe(48);
    expect(first.selection.fixed_structured_count).toBe(10);
    expect(first.source_commit).toBe(commit);
    expect(first.source_url).toBe(`https://github.com/DeepLinkX/DeeplinkX/tree/${commit}`);
    expect(first.queries.find((query) => query.lane === "compact-core")?.sources[0].location)
      .toBe(STABLE_FIXED_CATALOG_SOURCE);
  });
});
