import { sha256Hex, stableJson } from "../shared/catalog.js";
import type { StartupMessage, StartupRequest } from "../shared/types.js";
import { syncCatalog } from "./catalog-store.js";
import { startCompetitorBackfill, PermanentCompetitorError, RetryableCompetitorError } from "./competitors.js";
import { startIntelligence } from "./intelligence.js";
import { isD1DailyQuotaError, quotaResetDelay } from "./quota.js";
import { PubdevDeferredError } from "./pubdev.js";
import { RetryableScanError } from "./scanner.js";
import { createRun } from "./run-service.js";

interface Operation {
  message: StartupMessage;
  status: "starting" | "started" | "failed";
  result?: { body: Record<string, unknown>; status: number };
  error?: string;
  updatedAt: string;
}
const key = (id: string) => `startup:${id}`;
async function read(env: Env, id: string): Promise<Operation | null> {
  const row = await env.DB.prepare("SELECT value_json FROM system_state WHERE key=?").bind(key(id)).first<{value_json:string}>();
  return row ? JSON.parse(row.value_json) as Operation : null;
}
async function save(env: Env, operation: Operation): Promise<void> {
  await env.DB.prepare("INSERT INTO system_state(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
    .bind(key(operation.message.operationId), JSON.stringify(operation), operation.updatedAt).run();
}
export async function startupMessage(request: StartupRequest, idempotencyKey: string, date = new Date()): Promise<StartupMessage> {
  return {kind:"start-operation", operationId:await sha256Hex(`${request.type}:${idempotencyKey}`), idempotencyKey, requestedAt:date.toISOString(), request};
}
export async function executeStartup(env: Env, incoming: StartupMessage): Promise<{body:Record<string,unknown>;status:number}> {
  let operation = await read(env, incoming.operationId);
  if (operation && stableJson(operation.message.request) !== stableJson(incoming.request)) {
    throw new PermanentCompetitorError("Idempotency key already belongs to a different startup request.", "startup-idempotency-conflict");
  }
  if (operation?.status === "started" && operation.result) {
    if (operation.message.request.type === "run") {
      const run = await env.DB.prepare("SELECT * FROM runs WHERE idempotency_key=?").bind(operation.message.idempotencyKey).first();
      if (run) return {...operation.result,body:{...operation.result.body,run}};
    }
    return operation.result;
  }
  if (operation?.status === "failed") throw new PermanentCompetitorError(operation.error ?? "Startup failed.", "startup-failed");
  if (!operation) {
    operation = {message:incoming,status:"starting",updatedAt:new Date().toISOString()};
    // Insert-only establishes the first request date/scope even under delivery races.
    await env.DB.prepare("INSERT OR IGNORE INTO system_state(key,value_json,updated_at) VALUES(?,?,?)")
      .bind(key(incoming.operationId),JSON.stringify(operation),operation.updatedAt).run();
    operation = (await read(env,incoming.operationId))!;
    if (stableJson(operation.message.request) !== stableJson(incoming.request)) throw new PermanentCompetitorError("Idempotency key already belongs to a different startup request.","startup-idempotency-conflict");
  }
  const message = operation.message;
  let result: {body:Record<string,unknown>;status:number};
  if (message.request.type === "run") {
    // A resumed run retains its already selected catalog; do not sync over it.
    const existing = await env.DB.prepare("SELECT id FROM runs WHERE idempotency_key=?").bind(message.idempotencyKey).first();
    if (message.request.triggerSource === "cron" && !existing) await syncCatalog(env);
    const run = await createRun(env,{...message.request,idempotencyKey:message.idempotencyKey,date:new Date(message.requestedAt)});
    result = {body:{run},status:run.status === "skipped" ? 200 : 202};
  } else if (message.request.type === "refresh") {
    if (message.request.runId && !await env.DB.prepare("SELECT id FROM runs WHERE id=?").bind(message.request.runId).first()) throw new PermanentCompetitorError("Unknown run.","startup-run-unavailable");
    result = {body:await startIntelligence(env,`manual:${message.idempotencyKey}`,message.request.runId,message.request.full) as Record<string,unknown>,status:202};
  } else {
    const body = await startCompetitorBackfill(env,message.idempotencyKey,message.request.runId);
    result = {body:{...body},status:body.already_started ? 200 : 202};
  }
  await save(env,{...operation,status:"started",result,updatedAt:new Date().toISOString()});
  return result;
}

/** Quota-blocked API starts are accepted only after Queue confirms durable delivery. */
export async function admitStartup(env: Env, message: StartupMessage): Promise<{body:Record<string,unknown>;status:number}> {
  try { return await executeStartup(env,message); }
  catch (error) {
    if (!isD1DailyQuotaError(error) && !(error instanceof PubdevDeferredError) && !(error instanceof RetryableScanError) && !(error instanceof RetryableCompetitorError)) throw error;
    const delaySeconds = isD1DailyQuotaError(error) ? quotaResetDelay() : (error as PubdevDeferredError).delaySeconds;
    try { await env.SCAN_QUEUE.send(message,{delaySeconds}); }
    catch { throw new StartupQueueUnavailable(); }
    return {status:202,body:{operation_id:message.operationId,status:"deferred",resume_after:new Date(Date.now()+delaySeconds*1000).toISOString(),status_url:`/api/v1/operations/${message.operationId}`,dashboard_url:`/operations/${message.operationId}`}};
  }
}
export class StartupQueueUnavailable extends Error {
  constructor() { super("The request could not be queued. Retry with the same Idempotency-Key."); }
}
export async function failStartup(env: Env, message: StartupMessage, error: unknown): Promise<void> {
  const previous = await read(env,message.operationId);
  if (previous?.status === "started" || (previous && stableJson(previous.message.request) !== stableJson(message.request))) return;
  await save(env,{message:previous?.message ?? message,status:"failed",error:error instanceof Error?error.message:String(error),updatedAt:new Date().toISOString()});
  if (message.request.type === "run") {
    await env.DB.prepare(`UPDATE runs SET status='incomplete',error_summary='Report startup exhausted its retries; inspect the startup operation.',updated_at=?
      WHERE idempotency_key=? AND report_materialized=0 AND status IN ('creating','queued','running')
      AND EXISTS (SELECT 1 FROM system_state s WHERE s.key='run-init:'||runs.id AND json_extract(s.value_json,'$.phase')!='complete')`)
      .bind(new Date().toISOString(),message.idempotencyKey).run();
  }
}
export async function startupStatus(env: Env, id: string) {
  const operation = await read(env,id);
  if (!operation) return null;
  const run = operation.result?.body.run as {id:string}|undefined ?? (operation.message.request.type === "run"
    ? await env.DB.prepare("SELECT id FROM runs WHERE idempotency_key=?").bind(operation.message.idempotencyKey).first<{id:string}>() : null);
  return {operation_id:id,status:operation.status,requested_at:operation.message.requestedAt,updated_at:operation.updatedAt,
    type:operation.message.request.type,run_id:run?.id ?? null,
    message:operation.status === "started" ? "Startup finished. Report and competitor work continue separately." : operation.status === "failed" ? "The request could not start. Ask the maintainer to inspect the operation." : "Waiting for startup to finish. Quota pauses resume automatically."};
}
