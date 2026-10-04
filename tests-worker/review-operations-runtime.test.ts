import {applyD1Migrations,env} from 'cloudflare:test';
import {beforeAll,afterEach,it,expect,vi} from 'vitest';
import catalog from '../catalog/catalog-v3.json';
import {createReviewOperation,bootstrapReviewOperation,claimReviewPacket,submitReviewResults,scheduleReviewResource,processReviewResource,reviewOperationStatus,finalizeReviewOperation,materializeReviewReport,handleReviewOperations,reviewEvidence} from '../src/worker/review-operations.js';
import {importReview} from '../src/worker/intelligence.js';
import {applicablePolicy} from '../src/worker/review-policy.js';
import type {PackageAnalysis} from '../src/shared/intelligence.js';
vi.mock('../src/worker/pubdev.js',async original=>({...await original<typeof import('../src/worker/pubdev.js')>(),beforePubdevRequest:vi.fn(),recordPubdevThrottle:vi.fn()}));
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
afterEach(()=>vi.restoreAllMocks());
const noise:PackageAnalysis={relationship:'noise',capability_category:'UI',rationale:'In-app draggable UI only.',capabilities:[],providers:[],actions:[],migration_status:'unsupported',expansion:false,review_status:'reviewed'};
const adjacent:PackageAnalysis={...noise,relationship:'adjacent',capability_category:'Inbound links',rationale:'Receives incoming links.',expansion:false};
async function seed(name:string,decision=adjacent,confirmed=true){
 const hash='a'.repeat(64),meta={name,version:'1.0.0',description:decision.relationship==='noise'?'In-app draggable UI':'Receive incoming app links',topics:[],repository:null};
 await env.DB.prepare('INSERT INTO competitor_registry(package_name,metadata_json,metadata_captured_at,documentation_text,documentation_version,evidence_hash,product_commit,analysis_json,relationship,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(name,JSON.stringify(meta),new Date().toISOString(),'Documented package behavior','1.0.0',hash,catalog.source_commit,JSON.stringify(decision),decision.relationship,'2020','2020').run();
 if(confirmed)await importReview(env,{package_name:name,evidence_hash:hash,product_commit:catalog.source_commit,reviewed_by:'fixture reviewer',decision});
 return hash;
}
async function op(key:string,body={}){return await createReviewOperation(env,key,{evidence_mode:'cloudflare_first',package_names:[],...body}) as any;}
it('reuses reviewed noise and blocks resources including stale jobs without deleting old metrics',async()=>{
 await seed('op_noise',noise);await env.DB.prepare("UPDATE competitor_registry SET downloads_30d=500,metrics_captured_at='2020' WHERE package_name='op_noise'").run();
 const o=await op('noise');await bootstrapReviewOperation(env,o.id,{packages:[{package_name:'op_noise'}]});
 const fetcher=vi.spyOn(globalThis,'fetch');
 await scheduleReviewResource(env,o.id,'op_noise','metadata');
 await env.DB.prepare("INSERT INTO review_operation_resources(operation_id,package_name,kind,status,queued) VALUES(?,'op_noise','metrics','pending',1)").bind(o.id).run();
 await processReviewResource(env,o.id,'op_noise','metrics','');
 expect(fetcher).not.toHaveBeenCalled();expect((await claimReviewPacket(env,o.id,'claim',{reviewer:'A'}) as any).packets).toHaveLength(0);
 expect(await reviewEvidence(env,o.id,{package_name:'op_noise',kind:'documentation'})).toEqual({status:'skipped_noise'});
 expect(await env.DB.prepare("SELECT downloads_30d FROM competitor_registry WHERE package_name='op_noise'").first()).toEqual({downloads_30d:500});
});
it('does not reopen noise for version-only updates, but does for observed external behavior',async()=>{
 await seed('op_noise_version',noise);await env.DB.prepare("UPDATE competitor_registry SET metadata_json=json_set(metadata_json,'$.version','2.0.0') WHERE package_name='op_noise_version'").run();
 const row=await env.DB.prepare("SELECT * FROM competitor_registry WHERE package_name='op_noise_version'").first<any>();
 expect((await applicablePolicy(env,row,catalog.source_commit)).skippedNoise).toBe(true);
 row.metadata_json=JSON.stringify({...JSON.parse(row.metadata_json),description:'Share WhatsApp text through an external app'});
 expect((await applicablePolicy(env,row,catalog.source_commit)).policy?.state).toBe('reopened');
});
it('deduplicates membership and produces disjoint five-package leases',async()=>{
 const o=await op('leases');const records=Array.from({length:7},(_,i)=>({package_name:`op_unresolved_${i}`,question:'Does this package actually launch an external application?'}));
 await bootstrapReviewOperation(env,o.id,{packages:records});await bootstrapReviewOperation(env,o.id,{packages:records});
 const [a,b]=await Promise.all([claimReviewPacket(env,o.id,'a',{reviewer:'A'}),claimReviewPacket(env,o.id,'b',{reviewer:'B'})]) as any[];
 expect(a.packets.length).toBeLessThanOrEqual(5);expect(b.packets.length).toBeLessThanOrEqual(5);
 expect(a.packets.map((r:any)=>r.package_name).filter((n:string)=>b.packets.some((r:any)=>r.package_name===n))).toEqual([]);
 expect((await reviewOperationStatus(env,o.id) as any).counters.packages).toBe(7);
 await expect(finalizeReviewOperation(env,o.id,{})).rejects.toThrow('Unfinished work');
});
it('stores examined unknown answers and counts a repeated submission only once',async()=>{
 const o=await op('answer');await bootstrapReviewOperation(env,o.id,{packages:[{package_name:'op_gap',question:'Need platform evidence'}]});
 const packet=await claimReviewPacket(env,o.id,'a',{reviewer:'A'}) as any;
 const body={lease_key:packet.lease_key,results:[{package_name:'op_gap',finding:'Cached evidence does not identify any platform implementation.',sources:[{url:'https://pub.dev/packages/op_gap',label:'Stored metadata'}],unresolved_reason:'No platform implementation evidence retained.'}]};
 await submitReviewResults(env,o.id,body);await submitReviewResults(env,o.id,body);
 const status=await reviewOperationStatus(env,o.id) as any;expect(status.counters.pending_questions).toBe(0);expect(status.counters.newly_reviewed).toBe(1);
 vi.spyOn(env.SCAN_QUEUE,'send').mockResolvedValue(undefined);await finalizeReviewOperation(env,o.id,{notes:{summary:'An examined evidence gap.'}});await materializeReviewReport(env,o.id);
 expect((await reviewOperationStatus(env,o.id) as any).status).toBe('complete_with_gaps');
 const response=await handleReviewOperations(new Request(`https://test${'/api/v1/admin/competitors/review-operations'}/${o.id}/report`),env,`/api/v1/admin/competitors/review-operations/${o.id}/report`,'read');expect(await response.text()).toContain('op_gap');
 await expect(bootstrapReviewOperation(env,o.id,{packages:[{package_name:'op_late'}]})).rejects.toThrow('immutable');
});
it('fetches only score, preserves evidence identity and treats missing downloads as terminal',async()=>{
 await seed('op_score');const o=await op('score');await bootstrapReviewOperation(env,o.id,{packages:[{package_name:'op_score'}]});
 vi.spyOn(env.SCAN_QUEUE,'send').mockResolvedValue(undefined);await scheduleReviewResource(env,o.id,'op_score','metrics');await scheduleReviewResource(env,o.id,'op_score','metrics');
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({likeCount:2,grantedPoints:150,maxPoints:160}));
 await processReviewResource(env,o.id,'op_score','metrics','');await processReviewResource(env,o.id,'op_score','metrics','');await scheduleReviewResource(env,o.id,'op_score','metrics');
 expect(fetcher).toHaveBeenCalledTimes(1);expect(String(fetcher.mock.calls[0][0])).toBe('https://pub.dev/api/packages/op_score/score');
 expect(await env.DB.prepare("SELECT downloads_30d,evidence_hash FROM competitor_registry WHERE package_name='op_score'").first()).toEqual({downloads_30d:null,evidence_hash:'a'.repeat(64)});
 expect((await reviewOperationStatus(env,o.id) as any).counters.pending_resources).toBe(0);
});
it('reuses a successfully captured body after crash before aggregate completion',async()=>{
 await seed('op_crash');const o=await op('crash');await bootstrapReviewOperation(env,o.id,{packages:[{package_name:'op_crash'}]});vi.spyOn(env.SCAN_QUEUE,'send').mockResolvedValue(undefined);await scheduleReviewResource(env,o.id,'op_crash','metrics');
 await env.DB.prepare("UPDATE review_operation_resources SET status='captured',body=?,observed_at='2026-09-22T00:00:00Z' WHERE operation_id=?").bind(JSON.stringify({downloadCount30Days:8,likeCount:3}),o.id).run();
 const fetcher=vi.spyOn(globalThis,'fetch');await processReviewResource(env,o.id,'op_crash','metrics','');expect(fetcher).not.toHaveBeenCalled();
 expect(await env.DB.prepare("SELECT metrics_captured_at FROM competitor_registry WHERE package_name='op_crash'").first()).toEqual({metrics_captured_at:'2026-09-22T00:00:00Z'});
});
it('cloudflare-only records gaps and makes zero upstream requests',async()=>{
 await seed('op_only');const o=await op('only',{evidence_mode:'cloudflare_only'});await bootstrapReviewOperation(env,o.id,{packages:[{package_name:'op_only'}]});
 const fetcher=vi.spyOn(globalThis,'fetch');await scheduleReviewResource(env,o.id,'op_only','metrics');
 expect(fetcher).not.toHaveBeenCalled();expect((await reviewOperationStatus(env,o.id) as any).counters.resources_unavailable).toBe(1);
});
it('a 403 records an operation-wide cooldown instead of exhausting every package',async()=>{
 await seed('op_denied');const o=await op('denied');await bootstrapReviewOperation(env,o.id,{packages:[{package_name:'op_denied'}]});vi.spyOn(env.SCAN_QUEUE,'send').mockResolvedValue(undefined);await scheduleReviewResource(env,o.id,'op_denied','metrics');
 vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('denied',{status:403}));await expect(processReviewResource(env,o.id,'op_denied','metrics','')).rejects.toMatchObject({delaySeconds:43200});
 expect((await reviewOperationStatus(env,o.id) as any).retry_at).not.toBeNull();expect(await env.DB.prepare('SELECT attempts FROM review_operation_resources WHERE operation_id=?').bind(o.id).first()).toEqual({attempts:0});
});
it('rejects stale supporting evidence and requires an examined finding',async()=>{
 await seed('op_stale',adjacent,false);const o=await op('stale');await bootstrapReviewOperation(env,o.id,{packages:[{package_name:'op_stale'}]});const packet=await claimReviewPacket(env,o.id,'a',{reviewer:'A'}) as any;
 await env.DB.prepare("UPDATE competitor_registry SET evidence_hash=? WHERE package_name='op_stale'").bind('b'.repeat(64)).run();
 const result=await submitReviewResults(env,o.id,{lease_key:packet.lease_key,results:[{package_name:'op_stale',finding:'The inbound listener is adjacent.',sources:[{url:'https://pub.dev/packages/op_stale'}],unresolved_reason:'New evidence needs a packet.'}]}) as any;
 expect(result.results[0].status).toBe('evidence_changed');expect((await reviewOperationStatus(env,o.id) as any).counters.pending_questions).toBe(1);
});
it('keeps setup and unrelated sharing mentions excluded',async()=>{
 await seed('op_setup_noise',noise);const row=await env.DB.prepare("SELECT * FROM competitor_registry WHERE package_name='op_setup_noise'").first<any>();
 row.metadata_json=JSON.stringify({...JSON.parse(row.metadata_json),description:'Share this repository; open info.plist for setup; WhatsApp inspired draggable UI'});
 expect((await applicablePolicy(env,row,catalog.source_commit)).skippedNoise).toBe(true);
});
it('restores missing legacy metrics with original dates without reopening semantic work',async()=>{
 await seed('op_legacy_metrics');const o=await op('legacy-metrics');await bootstrapReviewOperation(env,o.id,{packages:[{package_name:'op_legacy_metrics'}]});
 await bootstrapReviewOperation(env,o.id,{metrics_only:true,packages:[{package_name:'op_legacy_metrics',metrics:{downloads_30d:42,likes:7},metrics_observed_at:'2026-09-22T00:00:00Z'}]});
 expect(await env.DB.prepare("SELECT downloads_30d,metrics_captured_at,evidence_hash FROM competitor_registry WHERE package_name='op_legacy_metrics'").first()).toEqual({downloads_30d:42,metrics_captured_at:'2026-09-22T00:00:00Z',evidence_hash:'a'.repeat(64)});
 expect((await claimReviewPacket(env,o.id,'claim',{reviewer:'A'}) as any).packets).toHaveLength(0);
});
it('preserves older score fields when a new valid response omits them',async()=>{
 await seed('op_missing_field');await env.DB.prepare("UPDATE competitor_registry SET downloads_30d=100 WHERE package_name='op_missing_field'").run();
 const o=await op('missing-field');await bootstrapReviewOperation(env,o.id,{packages:[{package_name:'op_missing_field'}]});vi.spyOn(env.SCAN_QUEUE,'send').mockResolvedValue(undefined);await scheduleReviewResource(env,o.id,'op_missing_field','metrics');
 vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({likeCount:2,grantedPoints:100}));await processReviewResource(env,o.id,'op_missing_field','metrics','');
 expect((await env.DB.prepare("SELECT downloads_30d FROM competitor_registry WHERE package_name='op_missing_field'").first<any>())?.downloads_30d).toBe(100);
 expect((await env.DB.prepare('SELECT missing_json FROM review_operation_resources WHERE operation_id=?').bind(o.id).first<any>())?.missing_json).toContain('downloads_30d');
});
it('reopens only an answered package whose supporting evidence changed before finalization',async()=>{
 await seed('op_changed_after_answer',adjacent,false);const o=await op('changed-after-answer');await bootstrapReviewOperation(env,o.id,{packages:[{package_name:'op_changed_after_answer'}]});
 const packet=await claimReviewPacket(env,o.id,'claim',{reviewer:'A'}) as any;
 await submitReviewResults(env,o.id,{lease_key:packet.lease_key,results:[{package_name:'op_changed_after_answer',finding:'The retained excerpt leaves the platform unestablished.',sources:[{url:'https://pub.dev/packages/op_changed_after_answer'}],unresolved_reason:'Platform evidence missing.'}]});
 await env.DB.prepare("UPDATE competitor_registry SET evidence_hash=? WHERE package_name='op_changed_after_answer'").bind('b'.repeat(64)).run();
 await expect(finalizeReviewOperation(env,o.id,{})).rejects.toThrow('Evidence changed');
 expect((await reviewOperationStatus(env,o.id) as any).counters.pending_questions).toBe(1);
 const reopened=await claimReviewPacket(env,o.id,'claim2',{reviewer:'A'}) as any;expect(reopened.packets[0].questions[0].frozen_hash).toBe('b'.repeat(64));
});
it('restores original provenance for excluded noise without resources or reviews',async()=>{
 await seed('op_provenance_noise',noise);const o=await op('provenance-noise',{package_names:['op_provenance_noise'],expected_packages:1});
 const provenance={origin:'manual_llm_review',reviewed_by:'original reviewer',reviewed_at:'2026-09-20T00:00:00Z',source_review_sha256:'a'.repeat(64)};
 const fetcher=vi.spyOn(globalThis,'fetch');
 await bootstrapReviewOperation(env,o.id,{provenance_only:true,packages:[{package_name:'op_provenance_noise',provenance}]});
 const saved=await env.DB.prepare('SELECT provenance_json FROM review_operation_packages WHERE operation_id=?').bind(o.id).first<any>();
 expect(JSON.parse(saved.provenance_json).reviewed_at).toBe(provenance.reviewed_at);
 expect((await claimReviewPacket(env,o.id,'claim',{reviewer:'A'}) as any).packets).toHaveLength(0);expect(fetcher).not.toHaveBeenCalled();
});
it('preserves the documented version as baseline when observed publication is newer',async()=>{
 await seed('op_baseline',adjacent,false);await env.DB.prepare("UPDATE competitor_registry SET metadata_json=json_set(metadata_json,'$.version','2.0.0') WHERE package_name='op_baseline'").run();
 await importReview(env,{package_name:'op_baseline',evidence_hash:'a'.repeat(64),product_commit:catalog.source_commit,reviewed_by:'baseline reviewer',decision:adjacent});
 const row=await env.DB.prepare("SELECT metadata_json,documentation_text FROM competitor_review_policies WHERE package_name='op_baseline'").first<any>();
 expect(JSON.parse(row.metadata_json).version).toBe('1.0.0');expect(JSON.parse(row.metadata_json).observed_version).toBe('2.0.0');expect(row.documentation_text).toBe('Documented package behavior');
});

it('freezes unfinished server candidates while excluding reviewed noise and unchanged examined gaps',async()=>{
 await seed('op_auto_candidate',adjacent,false);await seed('op_auto_noise',noise);
 await seed('op_auto_gap',adjacent,false);const previous=await op('auto-previous',{package_names:['op_auto_gap'],expected_packages:1});
 await env.DB.prepare("INSERT INTO review_operation_packages(operation_id,package_name,disposition,relationship,evidence_hash,updated_at) VALUES(?,'op_auto_gap','wait_for_evidence','unknown',?,'2026')").bind(previous.id,'a'.repeat(64)).run();
 await env.DB.prepare("UPDATE review_operations SET status='complete_with_gaps',updated_at='9999' WHERE id=?").bind(previous.id).run();
 const fresh=await createReviewOperation(env,'auto-fresh',{evidence_mode:'cloudflare_only'}) as any;
 const names=(await env.DB.prepare('SELECT package_name FROM review_operation_packages WHERE operation_id=?').bind(fresh.id).all<any>()).results.map(r=>r.package_name);
 expect(names).toContain('op_auto_candidate');expect(names).not.toContain('op_auto_noise');expect(names).not.toContain('op_auto_gap');
 expect(fresh.counters.pending_questions).toBe(names.length);
 const listed=await handleReviewOperations(new Request('https://test/api/v1/admin/competitors/review-operations'),env,'/api/v1/admin/competitors/review-operations','read');
 expect((await listed.json() as any).operations.some((r:any)=>r.id===fresh.id)).toBe(true);
});

it('accepts compressed JSON with the same import contract and rejects oversized expansion',async()=>{
 const json=JSON.stringify({package_names:[],scope:'fixture'});
 const compressed=await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
 const response=await handleReviewOperations(new Request('https://test/api/v1/admin/competitors/review-operations',{method:'POST',headers:{'content-encoding':'gzip'},body:compressed}),env,'/api/v1/admin/competitors/review-operations','compressed-create');
 expect(response.status).toBe(200);
 const huge=await new Response(new Blob([' '.repeat(1000001)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
 const rejected=await handleReviewOperations(new Request('https://test/api/v1/admin/competitors/review-operations',{method:'POST',headers:{'content-encoding':'gzip'},body:huge}),env,'/api/v1/admin/competitors/review-operations','compressed-huge');
 expect(rejected.status).toBe(400);expect(await rejected.text()).toContain('1 MB');
});

it('bounds metric admission to twenty packages and returns the remaining cursor',async()=>{
 const names=Array.from({length:21},(_,i)=>`op_metrics_page_${String(i).padStart(2,'0')}`);
 for(const name of names){await seed(name);await env.DB.prepare("UPDATE competitor_registry SET metrics_captured_at='2026-09-22' WHERE package_name=?").bind(name).run();}
 const o=await op('metric-pages',{package_names:names,expected_packages:21});
 const first=await finalizeReviewOperation(env,o.id,{collect_metrics:true}) as any;expect(first.scheduled).toBe(20);expect(first.done).toBe(false);
 const last=await finalizeReviewOperation(env,o.id,{collect_metrics:true,cursor:first.cursor}) as any;expect(last.scheduled).toBe(1);expect(last.done).toBe(true);
});
