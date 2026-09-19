import { applyD1Migrations,env,SELF } from "cloudflare:test";
import {beforeAll,afterEach,describe,it,expect,vi} from "vitest";
import { refreshPackage,registerPackage,importReview,processIntelligenceJob,startIntelligence } from "../src/worker/intelligence.js";
import {RetryableCompetitorError} from "../src/worker/competitors.js";
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
afterEach(()=>vi.restoreAllMocks());
const metadata=(name:string)=>({name,latest:{version:"1.0.0",published:"2022-01-01T00:00:00Z",pubspec:{description:"Share WhatsApp text and links",topics:["whatsapp"]}}});
const doc='<section class="detail-tab-readme"><p>Share WhatsApp text and links with a phone number to chat.</p></section>';
const score={downloadCount30Days:1234,likeCount:30,grantedPoints:160,maxPoints:160,tags:["platform:android"]};
describe("persistent competitor intelligence",()=>{
 it("checkpoints each resource and honors retry after without refetching successful metadata",async()=>{
  const fetcher=vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(Response.json(metadata("checkpoint_links")))
    .mockResolvedValueOnce(new Response("limited",{status:429,headers:{"retry-after":"37"}}));
  await expect(refreshPackage(env,"checkpoint_links")).rejects.toMatchObject({delaySeconds:37});
  fetcher.mockResolvedValueOnce(new Response(doc)).mockResolvedValueOnce(Response.json(score));
  const result=await refreshPackage(env,"checkpoint_links",2);
  expect(result).toMatchObject({downloads_30d:1234,relationship:"direct",refresh_status:"complete"});expect(fetcher).toHaveBeenCalledTimes(4);
  const observations=await env.DB.prepare("SELECT COUNT(*) AS count FROM competitor_metric_observations WHERE package_name='checkpoint_links'").first<{count:number}>();expect(observations?.count).toBe(1);
 });
 it("keeps missing scores null and partial rather than erasing functional evidence",async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(Response.json(metadata("partial_links"))).mockResolvedValueOnce(new Response(doc)).mockResolvedValueOnce(new Response("missing",{status:404}));
  const result=await refreshPackage(env,"partial_links");expect(result).toMatchObject({relationship:"direct",downloads_30d:null,refresh_status:"partial"});expect(result.metrics_error).toContain("404");
 });
 it("rejects stale review packets and persists an evidence-matched review",async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(Response.json(metadata("review_links"))).mockResolvedValueOnce(new Response(doc)).mockResolvedValueOnce(Response.json(score));
  const result=await refreshPackage(env,"review_links");
  const review={package_name:result.package_name,evidence_hash:result.evidence_hash,product_commit:result.product_commit,reviewed_by:"maintainer",decision:result};
  await expect(importReview(env,{...review,evidence_hash:"stale"})).rejects.toThrow(/stale/);
  await importReview(env,review);
  expect((await refreshPackage(env,"review_links")).review_status).toBe("reviewed");
 });
 it("filters the full registry before paginating and retains candidates beyond 500",async()=>{
  const analysis=JSON.stringify({relationship:"direct",providers:["WhatsApp"],actions:["shareText"],capabilities:[],migration_status:"partial",review_status:"rule_matched",expansion:false,capability_category:"sharing",rationale:"evidence"});
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<510)
    INSERT INTO competitor_registry(package_name,analysis_json,relationship,score_json,downloads_30d,first_seen_at,updated_at)
    SELECT 'candidate_'||printf('%03d',x),?,'direct',json_object('downloads_30d',x),x,'2026-09-19','2026-09-19' FROM n`).bind(analysis).run();
  const response=await SELF.fetch("https://test/api/v1/competitors?view=direct&q=candidate_&limit=10&page=2");
  const body=await response.json() as {total:number;competitors:Array<{package_name:string}>};expect(response.status).toBe(200);expect(body.total).toBe(510);expect(body.competitors[0].package_name).toBe("candidate_500");
  const filtered=await SELF.fetch("https://test/api/v1/competitors?view=direct&q=candidate_510");expect((await filtered.json() as {total:number}).total).toBe(1);
 });
 it("dispatches a bounded durable batch and makes repeated refresh requests idempotent",async()=>{
  const send=vi.spyOn(env.SCAN_QUEUE,"send").mockResolvedValue(undefined);
  const batch=vi.spyOn(env.SCAN_QUEUE,"sendBatch").mockResolvedValue(undefined);
  await startIntelligence(env,"refresh_test",undefined,false);
  await startIntelligence(env,"refresh_test",undefined,false);
  expect(send).toHaveBeenCalledTimes(1);
  await processIntelligenceJob(env,"refresh_test:dispatch",1);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(batch.mock.calls[0][0].length).toBeLessThanOrEqual(100);
  for(let i=0;i<10;i++) {
   const job=await env.DB.prepare("SELECT status FROM intelligence_jobs WHERE id='refresh_test:dispatch'").first<{status:string}>();
   if(job?.status==="complete") break;
   await processIntelligenceJob(env,"refresh_test:dispatch",1);
  }
  expect(batch.mock.calls.every(([messages])=>messages.length<=100)).toBe(true);
  expect((await env.DB.prepare("SELECT status FROM intelligence_jobs WHERE id='refresh_test:dispatch'").first<{status:string}>())?.status).toBe("complete");
 });
 it("checkpoints supplemental pages, preserves positions, and stops on exhaustion",async()=>{
  vi.spyOn(env.SCAN_QUEUE,"send").mockResolvedValue(undefined);
  const stamp=new Date().toISOString();
  await env.DB.prepare("INSERT INTO intelligence_jobs(id,kind,subject,created_at,updated_at) VALUES('search_test','search','sharing expansion',?,?)").bind(stamp,stamp).run();
  const fetcher=vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(Response.json({packages:Array.from({length:10},(_,i)=>({package:`supplement_${i}`})),next:"next"}));
  await processIntelligenceJob(env,"search_test",1);
  expect(await env.DB.prepare("SELECT next_page,status,result_count FROM intelligence_jobs WHERE id='search_test'").first()).toMatchObject({next_page:2,status:"queued",result_count:10});
  fetcher.mockResolvedValueOnce(new Response("limited",{status:429,headers:{"retry-after":"12"}}));
  await expect(processIntelligenceJob(env,"search_test",2)).rejects.toMatchObject({delaySeconds:12});
  fetcher.mockResolvedValueOnce(Response.json({packages:[{package:"supplement_last"}]}));
  await processIntelligenceJob(env,"search_test",3);
  expect(await env.DB.prepare("SELECT next_page,status,result_count FROM intelligence_jobs WHERE id='search_test'").first()).toMatchObject({next_page:3,status:"complete",result_count:11});
  expect(await env.DB.prepare("SELECT position,depth FROM competitor_discoveries WHERE package_name='supplement_last'").first()).toMatchObject({position:11,depth:100});
  await processIntelligenceJob(env,"search_test",4);
  expect(fetcher).toHaveBeenCalledTimes(3);
 });
});
