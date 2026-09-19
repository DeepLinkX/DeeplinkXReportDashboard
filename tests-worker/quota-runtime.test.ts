import { describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index.js";
import { handlePublicApi } from "../src/worker/api.js";
import { isD1DailyQuotaError, quotaResetDelay } from "../src/worker/quota.js";
import type { AuditQueueMessage } from "../src/shared/types.js";

const quotaError = new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow.");
function fixture(body: AuditQueueMessage, queue = "deeplinkx-visibility-scan") {
  const send = vi.fn().mockResolvedValue(undefined);
  const env = { DB: { prepare: vi.fn(() => { throw quotaError; }) }, SCAN_QUEUE: { send } } as unknown as Env;
  const message = { body, attempts: 12, ack: vi.fn(), retry: vi.fn() } as unknown as Message<AuditQueueMessage>;
  const batch = { queue, messages: [message] } as unknown as MessageBatch<AuditQueueMessage>;
  return { env, message, batch, send };
}

describe("D1 daily quota recovery", () => {
  it("distinguishes daily quota errors and bounds the next UTC reset delay", () => {
    expect(isD1DailyQuotaError(quotaError)).toBe(true);
    expect(isD1DailyQuotaError(new Error("D1_ERROR: SQL syntax error"))).toBe(false);
    expect(quotaResetDelay(new Date("2026-12-31T23:59:00Z"))).toBe(120);
    expect(quotaResetDelay(new Date("2026-09-19T22:00:00Z"))).toBe(7260);
    expect(quotaResetDelay(new Date("2026-09-19T01:00:00Z"))).toBe(43200);
  });

  it.each<AuditQueueMessage>([
    {kind:"start-operation",operationId:"a".repeat(64),idempotencyKey:"scheduled",requestedAt:"2026-09-19T00:00:00Z",request:{type:"run",profile:"full",triggerSource:"cron"}},
    { kind: "scan-query", runId: "original-run", queryId: "original-query" },
    { kind: "finalize-run", runId: "original-run" },
    { kind: "classify-competitors", runId: "original-run" },
    { kind: "enrich-competitor", runId: "original-run", packageName: "whatsapp_unilink" },
    { kind: "intelligence", jobId: "original-job" },
  ])("preserves $kind and reschedules without exhausting retries", async (body) => {
    const f = fixture(body);
    await worker.queue(f.batch, f.env, {} as ExecutionContext);
    expect(f.send).toHaveBeenCalledWith(body, { delaySeconds: expect.any(Number) });
    expect(f.message.ack).toHaveBeenCalledOnce();
    expect(f.message.retry).not.toHaveBeenCalled();
  });

  it("recovers a dead-letter job blocked by quota using its original payload", async () => {
    const f = fixture({ kind: "scan-query", runId: "original-run", queryId: "original-query" }, "deeplinkx-visibility-dlq");
    await worker.queue(f.batch, f.env, {} as ExecutionContext);
    expect(f.send).toHaveBeenCalledWith(f.message.body, { delaySeconds: expect.any(Number) });
    expect(f.message.ack).toHaveBeenCalledOnce();
  });

  it("never acknowledges a job when rescheduling fails", async () => {
    const f = fixture({ kind: "scan-query", runId: "original-run", queryId: "original-query" });
    f.send.mockRejectedValue(new Error("Queue unavailable"));
    await expect(worker.queue(f.batch, f.env, {} as ExecutionContext)).rejects.toThrow("Queue unavailable");
    expect(f.message.ack).not.toHaveBeenCalled();
  });

  it("returns a non-cacheable service pause instead of a bad-filter error", async () => {
    const f = fixture({ kind: "intelligence", jobId: "original-job" });
    const response = await handlePublicApi(new Request("https://test/api/v1/competitors"), f.env);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("daily quota") });
  });
});
