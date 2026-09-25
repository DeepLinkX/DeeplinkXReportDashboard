import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import importer from "../scripts/d1-backup-importer/worker.js";

const token = "test-import-token";
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

describe("temporary D1 backup importer", () => {
  it("imports one bounded chunk once and rejects conflicting reuse", async () => {
    const payload = { table: "system_state", columns: ["key", "value_json", "updated_at"], rows: [["import-test", "{}", "2026-09-25T00:00:00Z"]] };
    const source_sha256 = await digest(payload);
    const body = { ...payload, chunk_id: "test-system-state-1", source_sha256 };
    const request = () => new Request("https://import.test/chunks", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const first = await importer.fetch(request(), { DB: env.DB, IMPORT_TOKEN: token }, {} as ExecutionContext);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "imported", rows: 1, chunk_id: body.chunk_id });
    const duplicate = await importer.fetch(request(), { DB: env.DB, IMPORT_TOKEN: token }, {} as ExecutionContext);
    expect(await duplicate.json()).toMatchObject({ status: "already_imported", rows: 1 });

    const conflictPayload = { ...payload, rows: [["import-test", "changed", "2026-09-25T00:00:00Z"]] };
    const conflictHash = await digest(conflictPayload);
    const conflict = await importer.fetch(new Request("https://import.test/chunks", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...conflictPayload, chunk_id: body.chunk_id, source_sha256: conflictHash }),
    }), { DB: env.DB, IMPORT_TOKEN: token }, {} as ExecutionContext);
    expect(conflict.status).toBe(409);
    expect(await env.DB.prepare("SELECT value_json FROM system_state WHERE key='import-test'").first<{ value_json: string }>())
      .toMatchObject({ value_json: "{}" });
  });

  it("requires the import secret and rejects unlisted tables", async () => {
    const request = new Request("https://import.test/chunks", { method: "POST", body: "{}" });
    expect((await importer.fetch(request, { DB: env.DB, IMPORT_TOKEN: token }, {} as ExecutionContext)).status).toBe(401);
    const forbidden = await importer.fetch(new Request("https://import.test/chunks", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ chunk_id: "bad", source_sha256: "a".repeat(64), table: "d1_migrations", columns: ["name"], rows: [["evil"]] }),
    }), { DB: env.DB, IMPORT_TOKEN: token }, {} as ExecutionContext);
    expect(forbidden.status).toBe(400);
  });
});
