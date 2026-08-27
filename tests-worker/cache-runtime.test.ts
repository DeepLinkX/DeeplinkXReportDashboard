import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { MUTABLE_CACHE_TAG } from "../src/worker/cache.js";

describe("Workers Cache public API entrypoint", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  it("routes canonical public reads through the cacheable entrypoint and exposes purge RPC", async () => {
    const first = await SELF.fetch("https://visibility.example/api/v1/summary?ignored=one");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("public, max-age=30");
    expect(first.headers.get("cache-tag")).toBe(MUTABLE_CACHE_TAG);

    const second = await SELF.fetch("https://visibility.example/api/v1/summary?ignored=two");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());

    const purged = await exports.PublicAPI.purge([MUTABLE_CACHE_TAG]);
    expect(typeof purged.success).toBe("boolean");

    const health = await SELF.fetch("https://visibility.example/api/v1/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
  });
});
