import { WorkerEntrypoint } from "cloudflare:workers";
import type { AuditQueueMessage } from "../shared/types.js";
import { handlePublicApi, handleUncachedApi } from "./api.js";
import {
  MUTABLE_CACHE_TAG,
  canonicalPublicRequest,
  purgePublicCacheTags,
  runCacheTag,
} from "./cache.js";
import { syncCatalog } from "./catalog-store.js";
import { finalizeRun } from "./reports.js";
import { recordDiagnostic } from "./retention.js";
import { createRun, markDeadLetter } from "./run-service.js";
import { RetryableScanError, recordRetry, scanQuery } from "./scanner.js";

export class PublicAPI extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return handlePublicApi(request, this.env);
  }

  async purge(tags: string[]): Promise<CachePurgeResult> {
    if (!this.ctx.cache) {
      return { success: false, errors: [{ code: 0, message: "Workers Cache is unavailable for PublicAPI." }] };
    }
    return this.ctx.cache.purge({ tags });
  }
}

async function invalidatePublicCache(
  context: ExecutionContext,
  env: Env,
  tags: string[],
  runId?: string,
): Promise<void> {
  const outcome = await purgePublicCacheTags(context.exports.PublicAPI, tags);
  if (outcome.success) return;
  const detail = `Public API cache purge failed for ${tags.join(", ")}: ${outcome.detail ?? "unknown failure"}`;
  try {
    await recordDiagnostic(env, {
      runId,
      severity: "warning",
      code: "cache-purge-failed",
      detail,
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "cache-purge-diagnostic-failed",
      run_id: runId ?? null,
      detail,
      diagnostic_error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function handleQueueMessage(
  message: Message<AuditQueueMessage>,
  env: Env,
  context: ExecutionContext,
): Promise<void> {
  if (message.body.kind === "finalize-run") {
    try {
      await finalizeRun(env, message.body.runId);
      await invalidatePublicCache(
        context,
        env,
        [MUTABLE_CACHE_TAG, runCacheTag(message.body.runId)],
        message.body.runId,
      );
      message.ack();
    } catch (error) {
      await recordDiagnostic(env, {
        runId: message.body.runId,
        severity: "warning",
        code: "finalizer-retry",
        detail: error instanceof Error ? error.message : String(error),
      });
      message.retry({ delaySeconds: Math.min(3_600, 10 * 2 ** Math.min(message.attempts, 9)) });
    }
    return;
  }
  try {
    await scanQuery(env, message.body.runId, message.body.queryId, message.attempts);
    message.ack();
  } catch (error) {
    const retryable = error instanceof RetryableScanError
      ? error
      : new RetryableScanError(
        error instanceof Error ? error.message : String(error),
        Math.min(3_600, 10 * 2 ** Math.min(message.attempts, 9)),
        "scan-error",
      );
    await recordRetry(env, message.body.runId, message.body.queryId, retryable);
    message.retry({ delaySeconds: retryable.delaySeconds });
  }
}

export default {
  async fetch(request, env, context): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const publicRequest = canonicalPublicRequest(request);
      if (publicRequest) return context.exports.PublicAPI.fetch(publicRequest);
      return handleUncachedApi(
        request,
        env,
        (tags, runId) => invalidatePublicCache(context, env, tags, runId),
      );
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, context): Promise<void> {
    await syncCatalog(env);
    const profile = event.cron === "0 0 1 * *" ? "full" : "pulse";
    const date = new Date(event.scheduledTime);
    const dateKey = date.toISOString().slice(0, 10);
    const run = await createRun(env, {
      profile,
      date,
      triggerSource: "cron",
      idempotencyKey: `cron:${profile}:${dateKey}`,
    });
    await invalidatePublicCache(context, env, [MUTABLE_CACHE_TAG, runCacheTag(run.id)], run.id);
  },

  async queue(batch, env, context): Promise<void> {
    for (const message of batch.messages) {
      if (batch.queue === "deeplinkx-visibility-dlq") {
        try {
          await markDeadLetter(env, message.body, `Exhausted Queue retries after ${message.attempts} attempts.`);
          await invalidatePublicCache(
            context,
            env,
            [MUTABLE_CACHE_TAG, runCacheTag(message.body.runId)],
            message.body.runId,
          );
          message.ack();
        } catch (error) {
          await recordDiagnostic(env, {
            severity: "error",
            code: "dead-letter-handler-failed",
            detail: error instanceof Error ? error.message : String(error),
          });
          message.retry({ delaySeconds: 300 });
        }
        continue;
      }
      await handleQueueMessage(message, env, context);
    }
  },
} satisfies ExportedHandler<Env, AuditQueueMessage>;
