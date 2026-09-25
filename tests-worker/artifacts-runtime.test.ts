import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { loadReportArtifactContent, storeReportArtifact } from "../src/worker/artifacts.js";
import { sha256Hex } from "../src/shared/catalog.js";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const now = "2026-09-25T00:00:00.000Z";
  await env.DB.prepare(`INSERT OR IGNORE INTO catalogs
    (catalog_version,schema_version,catalog_revision,source_commit,source_url,content_hash,content_json,pulse_count,full_count,created_at,is_active)
    VALUES ('artifact-test',3,'test','commit','https://example.test','hash','{}',0,1,?,0)`).bind(now).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO runs
    (id,profile,catalog_version,report_date,requested_depth,effective_depth,trigger_source,idempotency_key,status,query_count,completed_count,failed_count,created_at,updated_at,report_materialized)
    VALUES ('artifact-test-run','full','artifact-test','2026-09-25',100,100,'test','artifact-test','complete',1,1,0,?,?,1)`)
    .bind(now, now).run();
});

describe("report artifact storage", () => {
  it("stores oversized UTF-8 content in ordered chunks and restores identical bytes", async () => {
    const content = `${"a😀parham\n".repeat(180_000)}終`; // >1.5 MB but under the reconstructed export limit.
    const contentHash = await sha256Hex(content);
    await storeReportArtifact(env, {
      id: "artifact-test-large", runId: "artifact-test-run", type: "markdown",
      filename: "large.md", contentType: "text/markdown; charset=utf-8", content,
      contentHash, createdAt: "2026-09-25T00:00:00.000Z",
    });
    const row = await env.DB.prepare("SELECT id,content,content_hash,content_storage FROM report_artifacts WHERE id=?")
      .bind("artifact-test-large").first<{ id: string; content: string; content_hash: string; content_storage: "inline" | "chunked" }>();
    expect(row?.content_storage).toBe("chunked");
    expect(row?.content).toBe("");
    const parts = await env.DB.prepare("SELECT COUNT(*) AS count,MAX(LENGTH(content)) AS max_length FROM report_artifact_chunks WHERE artifact_id=?")
      .bind("artifact-test-large").first<{ count: number; max_length: number }>();
    expect(parts?.count).toBeGreaterThan(1);
    expect(parts?.max_length).toBeLessThanOrEqual(256_000);
    expect(await loadReportArtifactContent(env, row!)).toBe(content);
  });

  it("keeps small artifacts inline and removes prior chunks on replacement", async () => {
    const content = "updated artifact";
    const contentHash = await sha256Hex(content);
    await storeReportArtifact(env, {
      id: "artifact-test-large", runId: "artifact-test-run", type: "markdown",
      filename: "small.md", contentType: "text/markdown; charset=utf-8", content,
      contentHash, createdAt: "2026-09-25T00:00:01.000Z",
    });
    const row = await env.DB.prepare("SELECT id,content,content_hash,content_storage FROM report_artifacts WHERE id=?")
      .bind("artifact-test-large").first<{ id: string; content: string; content_hash: string; content_storage: "inline" | "chunked" }>();
    expect(row?.content_storage).toBe("inline");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM report_artifact_chunks WHERE artifact_id=?")
      .bind("artifact-test-large").first<{ count: number }>()).toMatchObject({ count: 0 });
    expect(await loadReportArtifactContent(env, row!)).toBe(content);
  });
});
