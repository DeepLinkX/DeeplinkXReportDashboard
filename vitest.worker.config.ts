import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [cloudflareTest({
      main: "./src/worker/index.ts",
      additionalExports: { PublicAPI: "WorkerEntrypoint" },
      miniflare: {
        compatibilityDate: "2026-08-22",
        bindings: { TEST_MIGRATIONS: migrations, D1_WRITES_PAUSED: "false" },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    })],
    test: {
      include: ["tests-worker/**/*.test.ts"],
      coverage: { enabled: false },
    },
  };
});
