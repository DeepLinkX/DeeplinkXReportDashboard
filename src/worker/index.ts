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
import { RetryableScanError, recordRetry, scanQuery, retryDelay } from "./scanner.js";
import { startIntelligence, processIntelligenceJob, failIntelligenceJob } from "./intelligence.js";
import { PubdevDeferredError } from "./pubdev.js";
import { isD1DailyQuotaError, quotaResetDelay } from "./quota.js";
import {
  PermanentCompetitorError,
  RetryableCompetitorError,
  completeCompetitorEnrichment,
  enrichCompetitor,
  markCompetitorFailed,
  recordCompetitorRetry,
  dispatchCompetitorClassifications,
} from "./competitors.js";

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
  if (message.body.kind === "intelligence") {
    try {
      await processIntelligenceJob(env, message.body.jobId, message.attempts);
      await invalidatePublicCache(context, env, [MUTABLE_CACHE_TAG]);
      message.ack();
    } catch (error) {
      if (isD1DailyQuotaError(error)) throw error;
      if (await deferPubdev(message,env,error)) return;
      const permanent = error instanceof PermanentCompetitorError;
      await failIntelligenceJob(env, message.body.jobId, error, permanent);
      if (permanent) message.ack();
      else message.retry({ delaySeconds: error instanceof RetryableCompetitorError ? error.delaySeconds : retryDelay(null, message.attempts) });
    }
    return;
  }
  if (message.body.kind === "classify-competitors") {
    await dispatchCompetitorClassifications(env, message.body.runId);
    message.ack();
    return;
  }
  if (message.body.kind === "finalize-run") {
    try {
      await finalizeRun(env, message.body.runId);
      const completed = await env.DB.prepare("SELECT profile,status FROM runs WHERE id=?").bind(message.body.runId).first<{profile:string;status:string}>();
      if (completed?.status === "complete") await startIntelligence(env, `run:${message.body.runId}`, message.body.runId, completed.profile === "full");
      await invalidatePublicCache(
        context,
        env,
        [MUTABLE_CACHE_TAG, runCacheTag(message.body.runId)],
        message.body.runId,
      );
      message.ack();
    } catch (error) {
      if (isD1DailyQuotaError(error)) throw error;
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
  if (message.body.kind === "enrich-competitor") {
    try {
      await enrichCompetitor(env, message.body.runId, message.body.packageName, message.attempts);
      const completion = await completeCompetitorEnrichment(env, message.body.runId);
      if (completion.ready && completion.materialized) {
        await invalidatePublicCache(
          context,
          env,
          [MUTABLE_CACHE_TAG, runCacheTag(message.body.runId)],
          message.body.runId,
        );
      }
      message.ack();
    } catch (error) {
      if (isD1DailyQuotaError(error)) throw error;
      if (await deferPubdev(message,env,error)) return;
      if (error instanceof PermanentCompetitorError) {
        await markCompetitorFailed(env, message.body.runId, message.body.packageName, error);
        const completion = await completeCompetitorEnrichment(env, message.body.runId);
        if (completion.ready && completion.materialized) {
          await invalidatePublicCache(
            context,
            env,
            [MUTABLE_CACHE_TAG, runCacheTag(message.body.runId)],
            message.body.runId,
          );
        }
        message.ack();
        return;
      }
      const retryable = error instanceof RetryableCompetitorError
        ? error
        : new RetryableCompetitorError(
          error instanceof Error ? error.message : String(error),
          Math.min(3_600, 10 * 2 ** Math.min(message.attempts, 9)),
          "competitor-enrichment-error",
        );
      await recordCompetitorRetry(env, message.body.runId, message.body.packageName, retryable);
      message.retry({ delaySeconds: retryable.delaySeconds });
    }
    return;
  }
  try {
    await scanQuery(env, message.body.runId, message.body.queryId, message.attempts);
    message.ack();
  } catch (error) {
    if (isD1DailyQuotaError(error)) throw error;
    if (await deferPubdev(message,env,error)) return;
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

async function deferPubdev(message: Message<AuditQueueMessage>, env: Env, error: unknown): Promise<boolean> {
  if (!(error instanceof PubdevDeferredError)) return false;
  // A shared cooldown is scheduling, not a failed attempt for every queued query.
  // Re-send before acknowledging so a failed Queue write cannot lose the job.
  await env.SCAN_QUEUE.send(message.body,{delaySeconds:error.delaySeconds});
  message.ack();
  return true;
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
      try {
        if (batch.queue === "deeplinkx-visibility-dlq") {
          try {
            const detail = `Exhausted Queue retries after ${message.attempts} attempts.`;
            if (message.body.kind === "intelligence") {
              await failIntelligenceJob(env, message.body.jobId, detail, true);
              await invalidatePublicCache(context, env, [MUTABLE_CACHE_TAG]);
              message.ack();
              continue;
            }
            if (message.body.kind === "classify-competitors") {
              await recordDiagnostic(env, {runId:message.body.runId,severity:"error",code:"classification-dispatch-failed",detail});
              message.ack();
              continue;
            }
            if (message.body.kind === "enrich-competitor") {
              await markCompetitorFailed(env, message.body.runId, message.body.packageName, {
                code: "competitor-dead-letter",
                message: detail,
              });
              await completeCompetitorEnrichment(env, message.body.runId);
            } else {
              await markDeadLetter(env, message.body, detail);
            }
            await invalidatePublicCache(
              context,
              env,
              [MUTABLE_CACHE_TAG, runCacheTag(message.body.runId)],
              message.body.runId,
            );
            message.ack();
          } catch (error) {
            if (isD1DailyQuotaError(error)) throw error;
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
      } catch (error) {
        if (!isD1DailyQuotaError(error)) throw error;
        const delaySeconds = quotaResetDelay();
        // D1 cannot even store diagnostics at its daily limit. Preserve the
        // original job in Queue without consuming retries or fabricating dates.
        await env.SCAN_QUEUE.send(message.body,{delaySeconds});
        console.warn(JSON.stringify({code:"d1-daily-quota-deferred",delay_seconds:delaySeconds,kind:message.body.kind}));
        message.ack();
      }
    }
  },
} satisfies ExportedHandler<Env, AuditQueueMessage>;
