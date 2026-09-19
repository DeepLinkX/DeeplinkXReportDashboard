import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import worker from "../src/worker/index.js";
import { admitStartup, executeStartup, startupMessage, startupStatus } from "../src/worker/startup.js";
import { handleUncachedApi } from "../src/worker/api.js";
import { storeCatalog } from "../src/worker/catalog-store.js";
import catalog from "../catalog/catalog-v3.json";

vi.mock("../src/worker/pubdev.js",async(original)=>({...await original<typeof import("../src/worker/pubdev.js")>(),beforePubdevRequest:vi.fn()}));
const quota = new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit.");
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{await env.DB.prepare("UPDATE runs SET status='incomplete' WHERE idempotency_key IN ('partial-init','partial-dispatch')").run();});
afterEach(()=>vi.restoreAllMocks());
function blockedEnv() {
  const send=vi.fn().mockResolvedValue(undefined);
  return {send,env:{DB:{prepare:vi.fn(()=>{throw quota;})},SCAN_QUEUE:{send},ADMIN_TOKEN:"test-token"} as unknown as Env};
}
async function ready() {
  await storeCatalog(env,catalog,true);
  vi.spyOn(globalThis,"fetch").mockImplementation(async()=>Response.json({latest:{version:"1.5.1",pubspec:{}},likeCount:13,grantedPoints:160}));
  vi.spyOn(env.SCAN_QUEUE,"send").mockResolvedValue(undefined);
  return vi.spyOn(env.SCAN_QUEUE,"sendBatch").mockResolvedValue(undefined);
}

describe("durable startup recovery",()=>{
  it.each(["0 6 * * 1","0 0 1 * *"])("enqueues schedule %s before touching D1 and preserves the original date",async(cron)=>{
    const f=blockedEnv(); const scheduledTime=Date.parse("2026-09-01T00:00:00Z");
    await worker.scheduled({cron,scheduledTime} as ScheduledController,f.env,{} as ExecutionContext);
    expect(f.env.DB.prepare).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({kind:"start-operation",requestedAt:"2026-09-01T00:00:00.000Z",idempotencyKey:`cron:${cron.includes("1 *")?"full":"pulse"}:2026-09-01`}));
  });
  it("resumes a pause before the run is inserted using its saved request date",async()=>{
    await ready();const prepare=env.DB.prepare.bind(env.DB);
    const failing=vi.spyOn(env.DB,"prepare").mockImplementation((sql)=>{if(sql.includes("INSERT INTO runs"))throw quota;return prepare(sql);});
    const message=await startupMessage({type:"run",profile:"pulse",triggerSource:"manual"},"before-insert",new Date("2026-09-04T09:00:00Z"));
    expect((await admitStartup(env,message)).body.status).toBe("deferred");failing.mockRestore();
    const result=await executeStartup(env,{...message,requestedAt:"2026-09-06T00:01:00Z"});
    expect(result.body.run).toMatchObject({report_date:"2026-09-04",query_count:82});
    await env.DB.prepare("UPDATE runs SET status='complete' WHERE idempotency_key='before-insert'").run();
  });
  it("keeps same-date full-report conflicts and pulse skipping after delayed startup",async()=>{
    await ready();
    await env.DB.prepare(`INSERT INTO runs(id,profile,catalog_version,report_date,requested_depth,trigger_source,idempotency_key,status,query_count,created_at,updated_at,report_materialized)
      VALUES('protected-full','full',?,'2026-09-08',100,'manual','protected-full','complete',0,'2026-09-08','2026-09-08',1)`).bind(catalog.catalog_version).run();
    const pulse=await executeStartup(env,await startupMessage({type:"run",profile:"pulse",triggerSource:"manual"},"delayed-pulse",new Date("2026-09-08T23:00:00Z")));
    expect(pulse.body.run).toMatchObject({status:"skipped",report_date:"2026-09-08"});
    await expect(executeStartup(env,await startupMessage({type:"run",profile:"full",triggerSource:"manual"},"delayed-full",new Date("2026-09-08T23:00:00Z")))).rejects.toThrow(/materialized full report/);
  });
  it("accepts a quota-blocked manual request only after its intent is queued",async()=>{
    const f=blockedEnv();
    const response=await handleUncachedApi(new Request("https://test/api/v1/admin/runs",{method:"POST",headers:{authorization:"Bearer test-token","idempotency-key":"deferred-start"},body:JSON.stringify({profile:"full"})}),f.env,async()=>{});
    expect(response.status).toBe(202);expect(response.headers.get("cache-control")).toBe("no-store");
    const body=await response.json() as {operation_id:string;status:string;resume_after:string};
    expect(body.status).toBe("deferred");expect(body.operation_id).toMatch(/^[a-f0-9]{64}$/);
    expect(f.send).toHaveBeenCalledOnce();expect(f.send.mock.calls[0][0].operationId).toBe(body.operation_id);
  });
  it("returns 503 if the continuation cannot be queued",async()=>{
    const f=blockedEnv();f.send.mockRejectedValue(new Error("Queue unavailable"));
    const response=await handleUncachedApi(new Request("https://test/api/v1/admin/runs",{method:"POST",headers:{authorization:"Bearer test-token","idempotency-key":"queue-down"},body:'{"profile":"full"}'}),f.env,async()=>{});
    expect(response.status).toBe(503);expect(await response.text()).toContain("could not be queued");
  });
  it.each([{type:"refresh",full:false},{type:"backfill"}] as const)("defers $type before registry or backfill initialization",async(request)=>{
    const f=blockedEnv();const message=await startupMessage(request,request.type);
    expect((await admitStartup(f.env,message)).status).toBe(202);
    expect(f.send.mock.calls[0][0]).toEqual(message);
  });
  it("resumes missing rows using the original catalog without replacing completed evidence",async()=>{
    const dispatch=await ready();const batch=env.DB.batch.bind(env.DB);let groups=0;
    const failing=vi.spyOn(env.DB,"batch").mockImplementation((statements)=>{
      if(statements.length===75 && ++groups===2) return Promise.reject(quota);
      return batch(statements);
    });
    const message=await startupMessage({type:"run",profile:"full",triggerSource:"manual"},"partial-init",new Date("2026-09-05T11:00:00Z"));
    expect((await admitStartup(env,message)).body.status).toBe("deferred");failing.mockRestore();
    const run=await env.DB.prepare("SELECT id,catalog_version FROM runs WHERE idempotency_key='partial-init'").first<{id:string;catalog_version:string}>();
    expect(run).not.toBeNull();
    const query=await env.DB.prepare("SELECT query_id FROM run_queries WHERE run_id=? LIMIT 1").bind(run!.id).first<{query_id:string}>();
    await env.DB.prepare("UPDATE run_queries SET status='complete',rank=2,packages_json='[\"other\",\"deeplink_x\"]' WHERE run_id=? AND query_id=?").bind(run!.id,query!.query_id).run();
    await env.DB.prepare("UPDATE catalogs SET is_active=0").run();
    const response=await executeStartup(env,{...message,requestedAt:"2026-09-07T00:01:00Z"});
    expect(response.body.run).toMatchObject({id:run!.id,report_date:"2026-09-05",catalog_version:run!.catalog_version,query_count:642});
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM run_queries WHERE run_id=?").bind(run!.id).first()).toEqual({n:642});
    expect(await env.DB.prepare("SELECT rank,status,packages_json FROM run_queries WHERE run_id=? AND query_id=?").bind(run!.id,query!.query_id).first()).toMatchObject({rank:2,status:"complete",packages_json:'["other","deeplink_x"]'});
    expect(dispatch.mock.calls.flatMap(([messages])=>messages).length).toBe(641);
    await executeStartup(env,message);expect(dispatch.mock.calls.flatMap(([messages])=>messages).length).toBe(641);
    expect(await startupStatus(env,message.operationId)).toMatchObject({status:"started",run_id:run!.id});
  });
  it("resumes an interrupted dispatch cursor without fetching snapshots again",async()=>{
    const dispatch=await ready();dispatch.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("temporary Queue error"));
    const message=await startupMessage({type:"run",profile:"full",triggerSource:"manual"},"partial-dispatch");
    expect((await admitStartup(env,message)).body.status).toBe("deferred");
    const fetched=vi.mocked(fetch).mock.calls.length;
    dispatch.mockResolvedValue(undefined);await executeStartup(env,message);
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetched);
    expect(dispatch.mock.calls[2][0]).toEqual(dispatch.mock.calls[1][0]);
  });
  it("rejects changed idempotency scope and does not claim unknown operations are queued",async()=>{
    await ready();const first=await startupMessage({type:"refresh",full:false},"scope");await executeStartup(env,first);
    const changed=await startupMessage({type:"refresh",full:true},"scope");
    await expect(executeStartup(env,changed)).rejects.toThrow(/different startup request/);
    const response=await handleUncachedApi(new Request(`https://test/api/v1/operations/${"a".repeat(64)}`),env,async()=>{});
    expect(response.status).toBe(404);expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
