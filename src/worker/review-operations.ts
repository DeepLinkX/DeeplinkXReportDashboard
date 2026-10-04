import catalog from '../../catalog/catalog-v3.json';
import { sha256Hex, stableJson } from '../shared/catalog.js';
import type { PackageAnalysis } from '../shared/intelligence.js';
import { importReview, validPackageName } from './intelligence.js';
import { policyFor, REVIEW_POLICY_VERSION, REVIEW_SCOPE } from './review-policy.js';
import { syncEvidence } from './evidence-sync.js';
import { beforePubdevRequest, recordPubdevThrottle, PubdevDeferredError } from './pubdev.js';
import { isD1DailyQuotaError } from './quota.js';
import { readmeText } from '../shared/competitor-analysis.js';

type Row = Record<string, any>;
const stamp = () => new Date().toISOString();
const parse = (v: any, fallback: any = {}) => typeof v === 'string' ? JSON.parse(v) : v ?? fallback;
const namespace = '/api/v1/admin/competitors/review-operations';
const json = (body: unknown, status = 200) => Response.json(body, {status,headers:{'cache-control':'no-store'}});
const terminalResources = ['complete','reused','unavailable','skipped_noise'];
const finalStates = ['complete','complete_with_gaps'];
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

async function operation(env: Env, id: string): Promise<Row> {
 const row = await env.DB.prepare('SELECT * FROM review_operations WHERE id=?').bind(id).first<Row>();
 if (!row) throw new Error('Unknown review operation.');
 return row;
}
async function mutable(env: Env,id:string) { const op=await operation(env,id); if([...finalStates,"finalizing"].includes(op.status)) throw new Error('Completed operation is immutable.');return op; }
async function event(env: Env,id:string,key:string,deltas:Record<string,number>,after: D1PreparedStatement[] = []) {
 const args:any[]=[];
 const terms=Object.entries(deltas).map(([field,value])=>{args.push(`$.${field}`,`$.${field}`,value);return '?,COALESCE(json_extract(counters_json,?),0)+?';});
 await env.DB.batch([
  env.DB.prepare(`UPDATE review_operations SET counters_json=json_set(counters_json,${terms.join(',')}),updated_at=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM review_operation_events WHERE operation_id=? AND event_key=?)`).bind(...args,stamp(),id,id,key),
  env.DB.prepare('INSERT OR IGNORE INTO review_operation_events VALUES(?,?)').bind(id,key),
  ...after,
 ]);
}
async function receipt(env:Env,id:string,key:string,body:unknown,work:()=>Promise<unknown>) {
 const hash=await sha256Hex(stableJson(body));
 const old=await env.DB.prepare('SELECT request_hash,response_json FROM review_operation_receipts WHERE operation_id=? AND receipt_key=?').bind(id,key).first<Row>();
 if(old && old.request_hash!==hash) throw new Error('Idempotency key reused with different content.');
 if(old?.response_json) return parse(old.response_json);
 await env.DB.prepare('INSERT OR IGNORE INTO review_operation_receipts VALUES(?,?,?,?,?)').bind(id,key,hash,null,stamp()).run();
 const result=await work();
 await env.DB.prepare('UPDATE review_operation_receipts SET response_json=? WHERE operation_id=? AND receipt_key=?').bind(JSON.stringify(result),id,key).run();
 return result;
}
/** Freeze only unfinished Cloudflare candidates; unchanged examined gaps are reusable. */
async function unfinishedNames(env:Env):Promise<string[]> {
 const prior=await env.DB.prepare("SELECT id FROM review_operations WHERE status IN ('complete','complete_with_gaps') AND expected_packages IS NOT NULL ORDER BY updated_at DESC LIMIT 1").first<Row>();
 const names:string[]=[];let cursor='';
 for(;;){
  const page=await env.DB.prepare(`SELECT cr.package_name,cr.relationship,cr.evidence_hash,rp.state,old.disposition AS old_disposition,old.evidence_hash AS old_hash FROM competitor_registry cr
   LEFT JOIN competitor_review_policies rp ON rp.package_name=cr.package_name
   LEFT JOIN review_operation_packages old ON old.operation_id=? AND old.package_name=cr.package_name
   WHERE cr.package_name>? ORDER BY cr.package_name LIMIT 100`).bind(prior?.id??'',cursor).all<Row>();
  if(!page.results.length)break;
  for(const row of page.results)if(row.state!=='confirmed_noise' && ['unknown','direct','adjacent'].includes(row.relationship)
   && (!row.state||row.state==='reopened') && !(row.old_disposition==='wait_for_evidence'&&row.old_hash===row.evidence_hash))names.push(row.package_name);
  cursor=page.results.at(-1)!.package_name;
  if(names.length>100000)throw new Error('Unfinished inventory exceeds operation budget.');
 }
 return names;
}
async function seedUnfinishedQuestions(env:Env,id:string):Promise<void> {
 const op=await operation(env,id);
 await env.DB.prepare(`INSERT OR IGNORE INTO review_operation_packages(operation_id,package_name,disposition,relationship,evidence_hash,previous_json,provenance_json,bootstrap_complete,updated_at)
  SELECT ?,cr.package_name,'pending_review',cr.relationship,cr.evidence_hash,cr.analysis_json,'{"origin":"cloudflare_candidate"}',1,?
  FROM json_each(?) names JOIN competitor_registry cr ON cr.package_name=names.value`).bind(id,stamp(),op.manifest_json).run();
 await env.DB.prepare(`INSERT OR IGNORE INTO review_operation_questions(operation_id,package_name,question_key,lane,question,frozen_hash)
  SELECT operation_id,package_name,'candidate','new_candidate','Examine the unfinished package-owned external-app capability using cached evidence.',evidence_hash
  FROM review_operation_packages WHERE operation_id=? AND disposition='pending_review'`).bind(id).run();
 const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM review_operation_packages WHERE operation_id=? AND disposition='pending_review'").bind(id).first<Row>();
 await event(env,id,'seed-unfinished',{packages:count?.n??0,questions:count?.n??0,pending_questions:count?.n??0});
}
export async function createReviewOperation(env:Env,key:string,body:Row):Promise<unknown> {
 if(!['cloudflare_first','cloudflare_only'].includes(body.evidence_mode??'cloudflare_first') || (body.apply_reviews!==undefined && typeof body.apply_reviews!=='boolean') || (body.expected_packages!==undefined && (!Number.isInteger(body.expected_packages)||body.expected_packages<1||body.expected_packages>100000))) throw new Error('Invalid operation options.');
 const auto=body.package_names===undefined&&!/^(?:routine-metrics|observed-update):/.test(key);
 const id='review-'+(await sha256Hex(key)).slice(0,24);
 const existing=await env.DB.prepare('SELECT id FROM review_operations WHERE idempotency_key=?').bind(key).first();
 if(existing){const row=await operation(env,id);if(row.request_hash!==await sha256Hex(stableJson(body)))throw new Error('Idempotency key reused with different content.');return receipt(env,id,'create',body,async()=>{await seedExistingMembership(env,id);if(auto)await seedUnfinishedQuestions(env,id);return reviewOperationStatus(env,id);});}
 if(body.package_names && (!Array.isArray(body.package_names)||body.package_names.length>100000||new Set(body.package_names).size!==body.package_names.length||body.package_names.some((name:any)=>!validPackageName(name))))throw new Error('Invalid frozen package names.');
 const frozen=auto?await unfinishedNames(env):body.package_names??[];
 await env.DB.prepare('INSERT OR IGNORE INTO review_operations(id,idempotency_key,request_hash,manifest_json,product_commit,policy_version,scope,evidence_mode,apply_reviews,stop_on_quota,inventory_json,expected_packages,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .bind(id,key,await sha256Hex(stableJson(body)),JSON.stringify(frozen),catalog.source_commit,REVIEW_POLICY_VERSION,REVIEW_SCOPE,body.evidence_mode??'cloudflare_first',body.apply_reviews?1:0,body.stop_on_quota===false?0:1,JSON.stringify({id:catalog.catalog_version,product_commit:catalog.source_commit,capabilities:catalog.capabilities}),body.expected_packages??(auto?frozen.length:null),stamp(),stamp()).run();
 return receipt(env,id,'create',body,async()=>{await seedExistingMembership(env,id);if(auto)await seedUnfinishedQuestions(env,id);return reviewOperationStatus(env,id);});
}
async function seedExistingMembership(env:Env,id:string):Promise<void> {
 const op=await operation(env,id);if(!parse(op.manifest_json,[]).length)return;
 await env.DB.prepare(`INSERT OR IGNORE INTO review_operation_packages(operation_id,package_name,disposition,relationship,evidence_hash,provenance_json,import_status,bootstrap_complete,updated_at)
 SELECT ?,cr.package_name,CASE WHEN rp.state='confirmed_noise' THEN 'excluded_noise' ELSE 'reuse' END,
 json_extract(rp.decision_json,'$.relationship'),cr.evidence_hash,json_object('origin','production_policy','reviewed_by',rp.reviewed_by,'policy_confirmed_at',rp.confirmed_at),'reused',1,?
 FROM json_each(?) names JOIN competitor_registry cr ON cr.package_name=names.value JOIN competitor_review_policies rp ON rp.package_name=cr.package_name
 WHERE rp.scope=? AND (rp.state='confirmed_noise' OR (rp.state='active' AND rp.product_commit=? AND rp.policy_version=?))`)
 .bind(id,stamp(),op.manifest_json,REVIEW_SCOPE,op.product_commit,REVIEW_POLICY_VERSION).run();
 const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM review_operation_packages WHERE operation_id=? AND import_status='reused'").bind(id).first<Row>();
 await event(env,id,'seed-existing',{packages:count?.n??0,seeded_reuse:count?.n??0});
}
export async function reviewOperationStatus(env:Env,id:string):Promise<unknown> {
 const op=await operation(env,id);
 const blockers=await env.DB.prepare("SELECT package_name,kind,status,attempts,retry_at,error FROM review_operation_resources WHERE operation_id=? AND status IN ('pending','captured') ORDER BY retry_at,package_name LIMIT 5").bind(id).all<Row>();
 return {blockers:blockers.results,id,status:op.status,scope:op.scope,product_commit:op.product_commit,policy_version:op.policy_version,evidence_mode:op.evidence_mode,apply_reviews:Boolean(op.apply_reviews),stop_on_quota:Boolean(op.stop_on_quota),resource_dispatch:op.resource_dispatch,expected_packages:op.expected_packages,counters:parse(op.counters_json),retry_at:op.retry_at,updated_at:op.updated_at};
}
interface BootstrapRecord {
 package_name:string; decision?:PackageAnalysis; provenance?:Row; evidence?:Row;
 envelope?:Parameters<typeof importReview>[1]; question?:string; lane?:string;
 metrics?:Row; metrics_observed_at?:string; metrics_origin?:string;
}
async function restoreLegacyMetrics(env:Env,id:string,record:BootstrapRecord,row:Row|null):Promise<void> {
 if(!record.metrics||!record.metrics_observed_at||Number.isNaN(Date.parse(record.metrics_observed_at))||!row||!['direct','adjacent'].includes(row.relationship)||(await policyFor(env,record.package_name))?.state==='confirmed_noise')return;
 const m=record.metrics;const old=parse(row.score_json);
 const incoming={downloads_30d:number(m.downloads_30d),likes:number(m.likes),points:number(m.points),max_points:number(m.max_points),platforms:Array.isArray(m.platforms)?m.platforms:[],origin:record.metrics_origin??'legacy_report'};
 const newer=!row.metrics_captured_at||Date.parse(record.metrics_observed_at)>Date.parse(row.metrics_captured_at);
 if(!newer&&!Object.entries(incoming).some(([k,v])=>k!=='platforms'&&k!=='origin'&&v!==null&&row[k]===null))return;
 const merged:Row={...old,...incoming,field_observed_at:{...old.field_observed_at}};
 for(const k of ['downloads_30d','likes','points','max_points']) {
  if(incoming[k as keyof typeof incoming]!==null&&(newer||row[k]===null))merged.field_observed_at[k]=record.metrics_observed_at;
  else {merged[k]=row[k]??null;merged.field_observed_at[k]=old.field_observed_at?.[k]??row.metrics_captured_at;}
 }
 await env.DB.batch([
  env.DB.prepare('UPDATE competitor_registry SET score_json=?,downloads_30d=?,likes=?,points=?,max_points=?,metrics_captured_at=? WHERE package_name=? AND metrics_captured_at IS ?').bind(JSON.stringify(merged),merged.downloads_30d,merged.likes,merged.points,merged.max_points,newer?record.metrics_observed_at:row.metrics_captured_at,record.package_name,row.metrics_captured_at),
  env.DB.prepare('INSERT OR IGNORE INTO competitor_metric_observations VALUES(?,?,?)').bind(record.package_name,record.metrics_observed_at,JSON.stringify(incoming)),
 ]);
 await event(env,id,`legacy-metrics:${record.package_name}:${record.metrics_observed_at}`,{legacy_metrics_reused:1});
}
async function question(env:Env,id:string,name:string,key:string,lane:string,text:string,hash:string|null) {
 await env.DB.prepare('INSERT OR IGNORE INTO review_operation_questions(operation_id,package_name,question_key,lane,question,frozen_hash) VALUES(?,?,?,?,?,?)').bind(id,name,key,lane,text.slice(0,4000),hash).run();
 await event(env,id,`question:${name}:${key}`,{pending_questions:1,questions:1});
 await env.DB.prepare("UPDATE review_operation_packages SET disposition='pending_review' WHERE operation_id=? AND package_name=?").bind(id,name).run();
}
export async function bootstrapReviewOperation(env:Env,id:string,body:{packages:BootstrapRecord[];inventory?:Row;metrics_only?:boolean;provenance_only?:boolean}):Promise<unknown> {
 const op=await mutable(env,id);
 const frozenNames=new Set(parse(op.manifest_json,[]));
 if(frozenNames.size && body.packages?.some(p=>!frozenNames.has(p.package_name)))throw new Error('Package outside frozen inventory.');
 if(!Array.isArray(body.packages)||!body.packages.length||body.packages.length>10||new Set(body.packages.map(p=>p.package_name)).size!==body.packages.length) throw new Error('Bootstrap accepts 1–10 unique packages.');
 if(body.inventory) {
  if(body.inventory.product_commit!==op.product_commit || !Array.isArray(body.inventory.verified_shared_apis)) throw new Error('Invalid committed product inventory.');
  await env.DB.prepare('UPDATE review_operations SET inventory_json=? WHERE id=?').bind(JSON.stringify({...parse(op.inventory_json),...body.inventory}),id).run();
 }
 const results=[];
 for(const record of body.packages) {
  const name=record.package_name;if(!validPackageName(name)) throw new Error('Invalid package name.');
  if(body.provenance_only){
   const provenance=record.provenance;if(!provenance||typeof provenance.reviewed_by!=='string'||typeof provenance.origin!=='string'||(provenance.reviewed_at&&!Number.isFinite(Date.parse(provenance.reviewed_at)))||JSON.stringify(provenance).length>8000)throw new Error('Invalid original review provenance.');
   const result=await env.DB.prepare("UPDATE review_operation_packages SET provenance_json=json_patch(provenance_json,?) WHERE operation_id=? AND package_name=? AND json_extract(provenance_json,'$.source_review_sha256') IS NULL").bind(JSON.stringify(provenance),id,name).run();
   results.push({package_name:name,status:result.meta.changes?'original_provenance_restored':'provenance_reused'});continue;
  }
  if(body.metrics_only){const member=await env.DB.prepare('SELECT package_name FROM review_operation_packages WHERE operation_id=? AND package_name=?').bind(id,name).first();if(!member)throw new Error('Metrics restoration requires existing membership.');await restoreLegacyMetrics(env,id,record,await env.DB.prepare('SELECT * FROM competitor_registry WHERE package_name=?').bind(name).first<Row>());results.push({package_name:name,status:'legacy_metrics_reconciled'});continue;}
  const prior=await env.DB.prepare('SELECT disposition,bootstrap_complete FROM review_operation_packages WHERE operation_id=? AND package_name=?').bind(id,name).first<Row>();
  if(prior?.bootstrap_complete){results.push({package_name:name,status:'reused_membership'});continue;}
  let row=await env.DB.prepare('SELECT * FROM competitor_registry WHERE package_name=?').bind(name).first<Row>();
  const policy=await policyFor(env,name);
  let disposition=policy?.state==='confirmed_noise'?'excluded_noise':policy?.state==='active'?'reuse':record.decision?.relationship==='unknown' && record.provenance?.examined?'wait_for_evidence':'pending_review';
  const relation=policy?parse(policy.decision_json).relationship:record.decision?.relationship??'unknown';
  await env.DB.prepare('INSERT OR IGNORE INTO review_operation_packages(operation_id,package_name,disposition,relationship,evidence_hash,previous_json,provenance_json,import_status,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
   .bind(id,name,disposition,relation,row?.evidence_hash??null,policy?'{}':JSON.stringify(record.decision??{}),JSON.stringify(record.provenance??{}),policy?'reused':null,stamp()).run();
  await event(env,id,`member:${name}`,{packages:1});
  if(disposition==='pending_review' && record.evidence && row && record.envelope && op.apply_reviews) {
   const before=record.evidence.metadata,after=parse(row.metadata_json);
   const normalized=(text:string)=>text.replace(/\s+/g,' ').trim();
   const sameMeta=before?.name===after.name && before?.version===after.version && before?.description===after.description && stableJson(before?.topics??[])===stableJson(after.topics??[]) && before?.repository===after.repository;
   const sameDoc=normalized(record.evidence.documentation??'')===normalized(row.documentation_text??'');
   if(sameMeta && sameDoc && row.evidence_hash) {
    try {
     await importReview(env,{...record.envelope,evidence_hash:row.evidence_hash,product_commit:op.product_commit});
     disposition=record.decision?.relationship==='noise'?'excluded_noise':'reuse';
     await env.DB.prepare('UPDATE review_operation_packages SET disposition=?,import_status=? WHERE operation_id=? AND package_name=?').bind(disposition,'reconciled_reuse',id,name).run();
     await event(env,id,`semantic-reuse:${name}`,{reconciled_reuse:1});
    } catch(error){if(isD1DailyQuotaError(error))throw error;}
   }
  }
  if(disposition==='pending_review' && record.evidence) {
   try {
    const synced=await syncEvidence(env,{packages:[record.evidence as any],dry_run:false}) as Row;
    if(['synced','unchanged'].includes(synced.results[0].status)) {
     row=await env.DB.prepare('SELECT * FROM competitor_registry WHERE package_name=?').bind(name).first<Row>();
     const envelope=record.envelope;
     // Rebind only exact supporting resources, never merely a current hash.
     const resourcesAgree=row && stableJson(parse(row.metadata_json))===stableJson(record.evidence.metadata) && String(row.documentation_text??'')===record.evidence.documentation;
     if(op.apply_reviews && envelope && envelope.decision.relationship!=='unknown' && resourcesAgree) {
      await importReview(env,{...envelope,evidence_hash:row!.evidence_hash,product_commit:op.product_commit});
      disposition=envelope.decision.relationship==='noise'?'excluded_noise':'reuse';
      await env.DB.prepare('UPDATE review_operation_packages SET disposition=?,relationship=?,evidence_hash=?,import_status=? WHERE operation_id=? AND package_name=?').bind(disposition,envelope.decision.relationship,row!.evidence_hash,'imported',id,name).run();
      await event(env,id,`bootstrap-import:${name}`,{imported:1});
     }
    }
   } catch(error) { if(isD1DailyQuotaError(error)) throw error;await env.DB.prepare('UPDATE review_operation_packages SET import_status=? WHERE operation_id=? AND package_name=?').bind('conflict: '+(error instanceof Error?error.message:'Invalid evidence'),id,name).run(); }
  }
  await restoreLegacyMetrics(env,id,record,row);
  if(disposition==='pending_review' && record.evidence?.documentation) await env.DB.prepare('INSERT OR IGNORE INTO review_operation_resources(operation_id,package_name,kind,version,status,body,observed_at) VALUES(?,?,?,?,?,?,?)').bind(id,name,'legacy_documentation',record.evidence.metadata.version,'reused',record.evidence.documentation,record.evidence.observed_at).run();
  if(disposition==='pending_review') await question(env,id,name,'reconcile',record.lane??'evidence_conflict',record.question??'Resolve the recorded evidence conflict before applying the previous decision.',row?.evidence_hash??null);
  await env.DB.prepare('UPDATE review_operation_packages SET bootstrap_complete=1 WHERE operation_id=? AND package_name=?').bind(id,name).run();
  results.push({package_name:name,status:disposition});
 }
 return {results};
}
export async function claimReviewPacket(env:Env,id:string,key:string,body:Row):Promise<unknown> {
 const op=await mutable(env,id);
 const reviewer=body.reviewer;if(typeof reviewer!=='string'||!reviewer.trim()||reviewer.length>120) throw new Error('Reviewer identity required.');
 const lease=`${reviewer}:${key}`;
 const claimed=await env.DB.prepare('SELECT DISTINCT package_name FROM review_operation_questions WHERE operation_id=? AND lease_key=? AND status=\'claimed\' ORDER BY package_name LIMIT 5').bind(id,lease).all<Row>();
 const available=claimed.results.length?claimed:await env.DB.prepare("SELECT DISTINCT q.package_name FROM review_operation_questions q JOIN review_operation_packages p ON p.operation_id=q.operation_id AND p.package_name=q.package_name WHERE q.operation_id=? AND (q.status='pending' OR (q.status='claimed' AND q.lease_until<?)) AND (p.lease_key IS NULL OR p.lease_until<? OR p.lease_key=?) ORDER BY q.package_name LIMIT 5").bind(id,stamp(),stamp(),lease).all<Row>();
 const packets=[];
 for(const {package_name:name} of available.results) {
  const locked=await env.DB.prepare('UPDATE review_operation_packages SET lease_key=?,lease_until=? WHERE operation_id=? AND package_name=? AND (lease_key IS NULL OR lease_key=? OR lease_until<?)').bind(lease,new Date(Date.now()+1800000).toISOString(),id,name,lease,stamp()).run();
  if(!locked.meta.changes)continue;
  await env.DB.prepare("UPDATE review_operation_questions SET status='claimed',lease_key=?,lease_until=? WHERE operation_id=? AND package_name=? AND (status='pending' OR (status='claimed' AND lease_until<?))")
   .bind(lease,new Date(Date.now()+1800000).toISOString(),id,name,stamp()).run();
  const qs=await env.DB.prepare("SELECT question_key,lane,question,frozen_hash FROM review_operation_questions WHERE operation_id=? AND package_name=? AND lease_key=? AND status='claimed'").bind(id,name,lease).all<Row>();
  if(!qs.results.length) continue;
  const p=await env.DB.prepare('SELECT * FROM review_operation_packages WHERE operation_id=? AND package_name=?').bind(id,name).first<Row>();
  if(p?.disposition==='excluded_noise') continue;
  const row=await env.DB.prepare('SELECT metadata_json,documentation_text,documentation_version,evidence_hash,evidence_sources_json FROM competitor_registry WHERE package_name=?').bind(name).first<Row>();
  const policy=await policyFor(env,name);
  await env.DB.prepare("UPDATE review_operation_questions SET frozen_hash=? WHERE operation_id=? AND package_name=? AND lease_key=? AND status='claimed'").bind(row?.evidence_hash??null,id,name,lease).run();
  const legacy=await env.DB.prepare("SELECT body,version FROM review_operation_resources WHERE operation_id=? AND package_name=? AND kind='legacy_documentation' LIMIT 1").bind(id,name).first<Row>();
  const delta=await env.DB.prepare("SELECT body,version FROM review_operation_resources WHERE operation_id=? AND package_name=? AND kind='changelog' AND status='complete' ORDER BY observed_at DESC LIMIT 1").bind(id,name).first<Row>();
  const documentation=delta?readmeText(delta.body.replaceAll('detail-tab-changelog','detail-tab-readme'),150000):String(row?.documentation_text??'');
  const excerpt=extractSection(documentation,body.focus??'');
  packets.push({package_name:name,questions:qs.results.map(q=>({...q,frozen_hash:row?.evidence_hash??null})),evidence_hash:row?.evidence_hash??null,metadata:parse(row?.metadata_json),documentation_version:row?.documentation_version,documentation_excerpt:legacy?changedExcerpt(legacy.body,documentation):excerpt,baseline_version:legacy?.version??parse(policy?.metadata_json).version,documentation_length:documentation.length,previous_decision:policy?parse(policy.decision_json):parse(p?.previous_json),provenance:parse(p?.provenance_json),sources:parse(row?.evidence_sources_json,[])});
 }
 await event(env,id,`packet:${key}`,{packets:1,packet_characters:JSON.stringify(packets).length});
 return {operation_id:id,lease_key:lease,product_commit:op.product_commit,inventory:body.include_inventory?compactInventory(parse(op.inventory_json)):{id:parse(op.inventory_json).id,product_commit:op.product_commit},packets};
}
function compactInventory(inventory:Row) {return {...inventory,capabilities:(inventory.capabilities??[]).map((c:Row)=>({provider:c.provider,action:c.action,api:c.api,platforms:c.platforms})),verified_shared_apis:inventory.verified_shared_apis??[]};}
function changedExcerpt(before:string,after:string):Row {
 const a=before.split('\n'),b=after.split('\n');let first=0;while(first<Math.min(a.length,b.length)&&a[first].trim()===b[first].trim())first++;
 return {changed_from_line:first+1,previous:extractSection(before,'',Math.max(0,first-3),1800),current:extractSection(after,'',Math.max(0,first-3),1800)};
}
export function extractSection(text:string,focus:string,start=0,limit=4000):Row {
 const lines=text.split('\n');
 const found=focus?lines.findIndex(line=>line.toLowerCase().includes(String(focus).toLowerCase())):-1;
 const first=Math.max(0,found>=0?found-3:start);
 const excerpt=lines.slice(first).join('\n').slice(0,Math.min(4000,Math.max(1,limit)));
 return {start_line:first+1,end_line:first+excerpt.split('\n').length,text:excerpt};
}
export async function reviewEvidence(env:Env,id:string,body:Row):Promise<unknown> {
 const op=await mutable(env,id);const name=body.package_name;
 if(!validPackageName(name??'')) throw new Error('Invalid package.');
 const member=await env.DB.prepare('SELECT disposition FROM review_operation_packages WHERE operation_id=? AND package_name=?').bind(id,name).first<Row>();
 if(!member) throw new Error('Package is outside this operation.');
 if(member.disposition==='excluded_noise'||(await policyFor(env,name))?.state==='confirmed_noise') return {status:'skipped_noise'};
 const kind=body.kind??'documentation';
 if(!['documentation','metadata','metrics','changelog'].includes(kind)) throw new Error('Invalid resource kind.');
 const row=await env.DB.prepare('SELECT * FROM competitor_registry WHERE package_name=?').bind(name).first<Row>();
 if(kind==='documentation') {
  const url=`https://pub.dev/packages/${name}/versions/${encodeURIComponent(row?.documentation_version??'')}`;
  const raw=await env.DB.prepare('SELECT body,body_hash,captured_at FROM raw_http_bodies WHERE source_url=? AND status_code=200 ORDER BY captured_at DESC LIMIT 1').bind(url).first<Row>();
  if(raw?.body) {
   try {const full=readmeText(raw.body,150000);if(full.length>String(row?.documentation_text??'').length)return {status:'stored_raw',version:row?.documentation_version,source_url:url,hash:raw.body_hash,observed_at:raw.captured_at,section:extractSection(full,body.focus??'',number(body.start_line)?body.start_line-1:0)};}catch { /* Other retained resource shapes do not replace usable documentation. */ }
  }
 }
 if(kind==='documentation'&&row?.documentation_text && !body.upstream) return {status:'stored',evidence_hash:row.evidence_hash,version:row.documentation_version,section:extractSection(row.documentation_text,body.focus??'',number(body.start_line)?body.start_line-1:0)};
 if(kind==='metadata'&&row?.metadata_json && !body.upstream) return {status:'stored',metadata:parse(row.metadata_json),observed_at:row.metadata_captured_at};
 const cached=await env.DB.prepare('SELECT * FROM review_operation_resources WHERE operation_id=? AND package_name=? AND kind=? ORDER BY observed_at DESC LIMIT 1').bind(id,name,kind).first<Row>();
 if(cached?.status==='complete'||cached?.status==='reused') return {status:'stored',version:cached.version,section:extractSection(cached.body??'',body.focus??'')};
 if(op.evidence_mode==='cloudflare_only') return {status:'evidence_gap',reason:'Cloudflare-only mode: resource absent.'};
 if(typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>1000) throw new Error('Name the missing fact and why stored evidence cannot answer it.');
 await scheduleReviewResource(env,id,name,kind,body.reason);
 return {status:'scheduled'};
}
export async function scheduleReviewResource(env:Env,id:string,name:string,kind:string,reason='Missing relevant metrics'):Promise<void> {
 const op=await mutable(env,id);
 const member=await env.DB.prepare('SELECT relationship,disposition FROM review_operation_packages WHERE operation_id=? AND package_name=?').bind(id,name).first<Row>();
 if(!member) throw new Error('Package is outside operation.');
 if(member.disposition==='excluded_noise'||(await policyFor(env,name))?.state==='confirmed_noise') {await event(env,id,`resource-skip:${name}:${kind}`,{skipped_noise:1});return;}
 if(kind==='metrics'&&!['direct','adjacent'].includes(member.relationship)) throw new Error('Metrics require an established relevant package.');
 const row=await env.DB.prepare('SELECT metadata_json,metrics_captured_at FROM competitor_registry WHERE package_name=?').bind(name).first<Row>();
 const version=kind==='metrics'?'':String(parse(row?.metadata_json).version??'');
 const old=await env.DB.prepare('SELECT status,queued FROM review_operation_resources WHERE operation_id=? AND package_name=? AND kind=? AND version=?').bind(id,name,kind,version).first<Row>();
 if(old) {await event(env,id,`resource:${name}:${kind}:${version}`,{resources:1,pending_resources:old.queued?1:0,[`resources_${old.queued?'pending':old.status}`]:1});if(!terminalResources.includes(old.status))await kickReviewResources(env,id);return;}
 const reuseMetric=kind==='metrics' && row?.metrics_captured_at && (String(op.idempotency_key).startsWith('routine-metrics:') ? Date.now()-Date.parse(row.metrics_captured_at)<30*86400000 : true);
 const status=reuseMetric?'reused':op.evidence_mode==='cloudflare_only'?'unavailable':'pending';
 const url=kind==='metrics'?`https://pub.dev/api/packages/${name}/score`:kind==='metadata'?`https://pub.dev/api/packages/${name}`:kind==='changelog'?`https://pub.dev/packages/${name}/versions/${encodeURIComponent(version)}/changelog`:`https://pub.dev/packages/${name}/versions/${encodeURIComponent(version)}`;
 await env.DB.prepare('INSERT OR IGNORE INTO review_operation_resources(operation_id,package_name,kind,version,status,source_url,error,queued) VALUES(?,?,?,?,?,?,?,?)').bind(id,name,kind,version,status,url,status==='unavailable'?'Cloudflare-only mode':reason,status==='pending'?1:0).run();
 await event(env,id,`resource:${name}:${kind}:${version}`,{resources:1,pending_resources:terminalResources.includes(status)?0:1,[`resources_${status}`]:1});
 if(status==='pending') await kickReviewResources(env,id);
}
/** One dispatcher carries the entire phase through cooldowns and quota errors. */
export async function kickReviewResources(env:Env,id:string,force=false):Promise<void> {
 const op=await mutable(env,id);
 const changed=await env.DB.prepare("UPDATE review_operations SET resource_dispatch='queued' WHERE id=? AND (resource_dispatch='idle' OR ?=1)").bind(id,force?1:0).run();
 if(changed.meta.changes) {
  try {await env.SCAN_QUEUE.send({kind:'review-dispatch',operationId:id,stopOnQuota:Boolean(op.stop_on_quota)});}
  catch(error){await env.DB.prepare("UPDATE review_operations SET resource_dispatch='idle' WHERE id=?").bind(id).run();throw error;}
 }
}
export async function processReviewDispatch(env:Env,id:string):Promise<void> {
 const op=await operation(env,id);if(finalStates.includes(op.status))return;
 const resource=await env.DB.prepare("SELECT package_name,kind,version FROM review_operation_resources WHERE operation_id=? AND status IN ('captured','pending') ORDER BY status,retry_at,package_name LIMIT 1").bind(id).first<Row>();
 if(resource) {
  await processReviewResource(env,id,resource.package_name,resource.kind,resource.version);
  await env.SCAN_QUEUE.send({kind:'review-dispatch',operationId:id,stopOnQuota:Boolean(op.stop_on_quota)});
 } else {
  // CAS prevents losing newly admitted work between selection and idle transition.
  const idle=await env.DB.prepare("UPDATE review_operations SET resource_dispatch='idle' WHERE id=? AND NOT EXISTS(SELECT 1 FROM review_operation_resources WHERE operation_id=? AND status IN ('pending','captured'))").bind(id,id).run();
  if(!idle.meta.changes)await env.SCAN_QUEUE.send({kind:'review-dispatch',operationId:id,stopOnQuota:Boolean(op.stop_on_quota)});
 }
}
export async function processReviewResource(env:Env,id:string,name:string,kind:string,version:string):Promise<void> {
 const op=await operation(env,id);
 const resource=await env.DB.prepare('SELECT * FROM review_operation_resources WHERE operation_id=? AND package_name=? AND kind=? AND version=?').bind(id,name,kind,version).first<Row>();
 if(!resource)return;
 if(terminalResources.includes(resource.status)){if(resource.queued)await event(env,id,`resource-done:${name}:${kind}:${version}`,{pending_resources:-1,[`resources_${resource.status}`]:1});return;}
 const finish=async(status:string,error:string|null=null)=>{
  await env.DB.prepare('UPDATE review_operation_resources SET status=?,error=?,retry_at=NULL WHERE operation_id=? AND package_name=? AND kind=? AND version=?').bind(status,error,id,name,kind,version).run();
  await event(env,id,`resource-done:${name}:${kind}:${version}`,{pending_resources:-1,[`resources_${status}`]:1});
 };
 const member=await env.DB.prepare('SELECT disposition,relationship FROM review_operation_packages WHERE operation_id=? AND package_name=?').bind(id,name).first<Row>();
 if(member?.disposition==='excluded_noise'||(await policyFor(env,name))?.state==='confirmed_noise') {await finish('skipped_noise');return;}
 if(kind==='metrics'&&!['direct','adjacent'].includes(member?.relationship)) {await finish('unavailable','No longer a relevant metrics candidate.');return;}
 if(op.evidence_mode==='cloudflare_only') {await finish('unavailable','Cloudflare-only mode');return;}
 // Successful bodies survive crashes before parsing or completing their job.
 let body=resource.body;
 if(!body) {
  const notes=parse(op.notes_json);
  if(notes.upstream_denied_at && Date.now()-Date.parse(notes.upstream_denied_at)>=72*3600000) {await finish('unavailable','Persistent upstream denial exceeded 72 hours.');return;}
  await beforePubdevRequest(env);
  if(resource.attempts>=3){await finish('unavailable','Three transient resource attempts exhausted.');return;}
  await env.DB.prepare('UPDATE review_operation_resources SET attempts=attempts+1 WHERE operation_id=? AND package_name=? AND kind=? AND version=?').bind(id,name,kind,version).run();
  await event(env,id,`request:${name}:${kind}:${version}:${resource.attempts}`,{upstream_requests:1});
  let response:Response;
  try {response=await fetch(resource.source_url,{headers:{accept:kind==='metrics'||kind==='metadata'?'application/json':'text/html','user-agent':'deeplinkx-visibility/3.0'},redirect:'error',signal:AbortSignal.timeout(25000)});}
  catch {throw new PubdevDeferredError(60);}
  if(response.status===403){
   await response.body?.cancel();await recordPubdevThrottle(env,43200,response);
   await env.DB.prepare("UPDATE review_operations SET notes_json=json_set(notes_json,'$.upstream_denied_at',COALESCE(json_extract(notes_json,'$.upstream_denied_at'),?)),retry_at=? WHERE id=?").bind(stamp(),new Date(Date.now()+43200000).toISOString(),id).run();
   // Denial probes are global cooldowns, not transient attempts per package.
   await env.DB.prepare('UPDATE review_operation_resources SET attempts=attempts-1,retry_at=? WHERE operation_id=? AND package_name=? AND kind=? AND version=?').bind(new Date(Date.now()+43200000).toISOString(),id,name,kind,version).run();
   throw new PubdevDeferredError(43200);
  }
  if(response.status===429||response.status>=500){await response.body?.cancel();await recordPubdevThrottle(env,60,response);throw new PubdevDeferredError(60);}
  if(!response.ok){await response.body?.cancel();await finish('unavailable',`Upstream HTTP ${response.status}`);return;}
  const reader=response.body?.getReader();const decoder=new TextDecoder();let bytes=0;body='';
  if(reader) for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2000000){await reader.cancel();await finish('unavailable','Response exceeds bounded resource size.');return;}body+=decoder.decode(part.value,{stream:true});}
  body+=decoder.decode();
  await env.DB.prepare('UPDATE review_operation_resources SET body=?,content_hash=?,observed_at=?,status=\'captured\' WHERE operation_id=? AND package_name=? AND kind=? AND version=?').bind(body,await sha256Hex(body),stamp(),id,name,kind,version).run();
  resource.observed_at=stamp();
  await env.DB.prepare("UPDATE review_operations SET notes_json=json_remove(notes_json,'$.upstream_denied_at'),retry_at=NULL WHERE id=?").bind(id).run();
 }
 try {
  if(kind==='metrics') {
   const payload=JSON.parse(body);if(!['downloadCount30Days','likeCount','grantedPoints'].some(k=>k in payload)) throw new Error('Invalid score response.');
   const score={downloads_30d:number(payload.downloadCount30Days),likes:number(payload.likeCount),points:number(payload.grantedPoints),max_points:number(payload.maxPoints),platforms:Array.isArray(payload.tags)?payload.tags.filter((s:any)=>typeof s==='string'&&s.startsWith('platform:')).map((s:string)=>s.slice(9)):[]};
   const captured=resource.observed_at??stamp();
   const prior=await env.DB.prepare('SELECT score_json,downloads_30d,likes,points,max_points,metrics_captured_at FROM competitor_registry WHERE package_name=?').bind(name).first<Row>();
   const merged:Row={...score,field_observed_at:{}};const old=parse(prior?.score_json);
   for(const field of ['downloads_30d','likes','points','max_points']){merged.field_observed_at[field]=score[field as keyof typeof score]===null?(old.field_observed_at?.[field]??prior?.metrics_captured_at):captured;if(score[field as keyof typeof score]===null)merged[field]=prior?.[field]??null;}
   const missing=Object.entries(score).filter(([key,value])=>key!=='platforms'&&value===null).map(([key])=>key);
   await env.DB.batch([
    env.DB.prepare('UPDATE competitor_registry SET score_json=?,downloads_30d=?,likes=?,points=?,max_points=?,metrics_captured_at=?,metrics_error=NULL WHERE package_name=?').bind(JSON.stringify(merged),merged.downloads_30d,merged.likes,merged.points,merged.max_points,captured,name),
    env.DB.prepare('INSERT OR IGNORE INTO competitor_metric_observations VALUES(?,?,?)').bind(name,captured,JSON.stringify(score)),
    env.DB.prepare('UPDATE review_operation_resources SET missing_json=? WHERE operation_id=? AND package_name=? AND kind=? AND version=?').bind(JSON.stringify(missing),id,name,kind,version),
   ]);
  } else if(kind==='metadata'||kind==='documentation') {
   const row=await env.DB.prepare('SELECT * FROM competitor_registry WHERE package_name=?').bind(name).first<Row>();
   const payload=kind==='metadata'?JSON.parse(body):null;
   const metadata=payload?{name:payload.name,version:payload.latest?.version,published:payload.latest?.published??null,description:payload.latest?.pubspec?.description??'',topics:payload.latest?.pubspec?.topics??[],repository:payload.latest?.pubspec?.repository??null}:parse(row?.metadata_json);
   if(kind==='documentation'&&metadata.version!==version)throw new Error('Captured documentation version conflicts with current metadata.');
   const documentation=kind==='documentation'?readmeText(body,150000):String(row?.documentation_text??'');
   if(kind==='metadata'&&row?.documentation_text&&row.documentation_version!==metadata.version)throw new Error('New metadata version requires an explicitly reconciled documentation update.');
   const observed=resource.observed_at??stamp();
   const synced=await syncEvidence(env,{dry_run:false,packages:[{package_name:name,expected_evidence_hash:row?.evidence_hash??null,product_commit:op.product_commit,metadata,documentation,observed_at:observed,sources:[...parse(row?.evidence_sources_json,[]),{url:resource.source_url,sha256:await sha256Hex(body),observed_at:observed,reason:'Targeted operation resource'}].slice(-20)}]}) as Row;
   if(synced.results[0].status==='conflict')throw new Error(synced.results[0].reason);
  } else if(kind==='changelog') {
   const text=readmeText(body.replaceAll('detail-tab-changelog','detail-tab-readme'),150000);
   if(!text.trim()) {await finish('unavailable','Changelog unavailable; prior baseline retained.');return;}
   await question(env,id,name,`changelog:${version}`,'changelog_delta','Inspect only relevant additions since the recorded reviewed baseline.',null);
  }
  await finish('complete');
 } catch(error) {if(isD1DailyQuotaError(error))throw error;await finish('unavailable',error instanceof Error?error.message:'Invalid resource');}
}
export async function submitReviewResults(env:Env,id:string,body:Row):Promise<unknown> {
 const op=await mutable(env,id);
 if(!Array.isArray(body.results)||!body.results.length||body.results.length>5)throw new Error('Submit results for 1–5 packages.');
 const results=[];
 for(const result of body.results) {
  const name=result.package_name;if(!validPackageName(name??''))throw new Error('Invalid package.');
  const qs=await env.DB.prepare('SELECT * FROM review_operation_questions WHERE operation_id=? AND package_name=? AND lease_key=? AND status=\'claimed\'').bind(id,name,body.lease_key??'').all<Row>();
  if(!qs.results.length){results.push({package_name:name,status:'already_completed_or_unclaimed'});continue;}
  if(qs.results.some(q=>q.lease_until<stamp()))throw new Error('Review lease expired; reclaim the packet.');
  if(typeof result.finding!=='string'||!result.finding.trim()||result.finding.length>10000)throw new Error('An examined finding is required.');
  if(!Array.isArray(result.sources)||!result.sources.length||result.sources.length>20||result.sources.some((source:Row)=>!/^https:\/\//.test(source?.url??'')))throw new Error('Supporting sources are required.');
  const row=await env.DB.prepare('SELECT * FROM competitor_registry WHERE package_name=?').bind(name).first<Row>();
  if(qs.results.some(q=>q.frozen_hash && q.frozen_hash!==row?.evidence_hash)) {
   await env.DB.prepare("UPDATE review_operation_questions SET status='pending',lease_key=NULL,lease_until=NULL,frozen_hash=? WHERE operation_id=? AND package_name=? AND lease_key=?").bind(row?.evidence_hash??null,id,name,body.lease_key).run();
   results.push({package_name:name,status:'evidence_changed'});continue;
  }
  let disposition='wait_for_evidence';let importStatus='draft';let relation='unknown';
  if(result.envelope) {
   if(result.envelope.package_name!==name||result.envelope.evidence_hash!==row?.evidence_hash||result.envelope.product_commit!==op.product_commit) throw new Error('Answer envelope is stale or unbound.');
   const decision=result.envelope.decision as PackageAnalysis;
   relation=decision.relationship;
   const inventory=parse(op.inventory_json);const apis=new Set([...(inventory.capabilities??[]),...(inventory.verified_shared_apis??[])].map((c:Row)=>c.api));
   if((decision.capabilities??[]).some(c=>c.deeplinkx_apis.some(api=>!apis.has(api))))throw new Error('Unverified DeeplinkX API in mapping.');
   if(relation==='direct' && !(decision.capabilities??[]).some(c=>c.deeplinkx_apis.length && c.evidence.trim()))throw new Error('Direct requires a package-owned action and verified execution path.');
   if(op.apply_reviews && relation!=='unknown' && decision.review_status!=='needs_review' && decision.migration_status!=='needs_review') {
    await importReview(env,result.envelope);importStatus='imported';disposition=relation==='noise'?'excluded_noise':'reviewed';
   } else disposition=relation==='unknown'?'wait_for_evidence':'reviewed_draft';
  } else if(typeof result.unresolved_reason!=='string'||!result.unresolved_reason.trim())throw new Error('Unresolved answers require a concrete evidence gap.');
  await env.DB.prepare('UPDATE review_operation_packages SET disposition=?,relationship=?,result_json=?,import_status=?,evidence_hash=?,updated_at=? WHERE operation_id=? AND package_name=?').bind(disposition,relation,JSON.stringify(result),importStatus,row?.evidence_hash??null,stamp(),id,name).run();
  for(const q of qs.results) {
   await event(env,id,`answer:${name}:${q.question_key}`,{pending_questions:-1,answered_questions:1},[env.DB.prepare("UPDATE review_operation_questions SET status='answered',answer_json=? WHERE operation_id=? AND package_name=? AND question_key=? AND lease_key=?").bind(JSON.stringify({finding:result.finding,sources:result.sources,unresolved_reason:result.unresolved_reason??null}),id,name,q.question_key,body.lease_key)]);
  }
  await env.DB.prepare('UPDATE review_operation_packages SET lease_key=NULL,lease_until=NULL WHERE operation_id=? AND package_name=? AND lease_key=?').bind(id,name,body.lease_key).run();
  await event(env,id,`review:${name}`,{newly_reviewed:1,[`result_${relation}`]:1,[`imports_${importStatus}`]:1});
  if(['direct','adjacent'].includes(relation))await scheduleReviewResource(env,id,name,'metrics');
  results.push({package_name:name,status:disposition,import_status:importStatus});
 }
 return {results};
}
export async function finalizeReviewOperation(env:Env,id:string,body:Row):Promise<unknown> {
 const op=await operation(env,id);if(finalStates.includes(op.status))return reviewOperationStatus(env,id);
 if(body.notes_only){await mutable(env,id);if(!body.notes)throw new Error('Notes-only requests require report notes.');}
 if(body.notes){if(JSON.stringify(body.notes).length>100000)throw new Error('Report notes exceed bounded size.');await env.DB.prepare('UPDATE review_operations SET notes_json=json_patch(notes_json,?) WHERE id=?').bind(JSON.stringify(body.notes),id).run();}
 if(body.notes_only)return reviewOperationStatus(env,id);
 if(body.collect_metrics) {
  const rows=await env.DB.prepare("SELECT package_name FROM review_operation_packages WHERE operation_id=? AND relationship IN ('direct','adjacent') AND package_name>? ORDER BY package_name LIMIT 20").bind(id,body.cursor??'').all<Row>();
  for(const r of rows.results)await scheduleReviewResource(env,id,r.package_name,'metrics');
  return {scheduled:rows.results.length,cursor:rows.results.at(-1)?.package_name??null,done:rows.results.length<20};
 }
 if(body.resume){await kickReviewResources(env,id,true);return reviewOperationStatus(env,id);}
 const changed=await env.DB.prepare('SELECT p.package_name,cr.evidence_hash FROM review_operation_packages p JOIN competitor_registry cr ON cr.package_name=p.package_name WHERE p.operation_id=? AND p.result_json IS NOT NULL AND p.evidence_hash IS NOT cr.evidence_hash ORDER BY p.package_name LIMIT 10').bind(id).all<Row>();
 if(changed.results.length){for(const row of changed.results)await question(env,id,row.package_name,`evidence-change:${row.evidence_hash}`,'evidence_conflict','Supporting evidence changed after the answer. Examine only the changed claim.',row.evidence_hash);throw new Error(`Evidence changed for ${changed.results.length} answered packages; targeted questions reopened.`);}
 const counters=parse(op.counters_json);
 if(op.expected_packages && counters.packages!==op.expected_packages)throw new Error(`Frozen membership incomplete: ${counters.packages??0}/${op.expected_packages}.`);
 if((counters.pending_questions??0)>0||(counters.pending_resources??0)>0)throw new Error(`Unfinished work: ${counters.pending_questions??0} questions, ${counters.pending_resources??0} resources.`);
 await env.DB.prepare("UPDATE review_operations SET status='finalizing' WHERE id=?").bind(id).run();
 await env.SCAN_QUEUE.send({kind:'review-finalize',operationId:id,stopOnQuota:Boolean(op.stop_on_quota)});
 return {id,status:'finalizing'};
}
function csv(value:any){const s=String(value??'');return '"'+s.replaceAll('"','""')+'"';}
export async function materializeReviewReport(env:Env,id:string):Promise<void> {
 const op=await operation(env,id);if(finalStates.includes(op.status))return;
 const notes=parse(op.notes_json);const counters=parse(op.counters_json);
 const resources:Row[]=[];let resourceCursor=['','',''];
 for(;;){const page=await env.DB.prepare(`SELECT r.package_name,r.kind,r.version,r.status,r.error,r.attempts,r.observed_at,r.missing_json FROM review_operation_resources r JOIN review_operation_packages p ON p.operation_id=r.operation_id AND p.package_name=r.package_name WHERE r.operation_id=? AND p.disposition!='excluded_noise' AND (r.package_name,r.kind,r.version)>(?,?,?) ORDER BY r.package_name,r.kind,r.version LIMIT 100`).bind(id,...resourceCursor).all<Row>();if(!page.results.length)break;resources.push(...page.results.map(r=>({...r,missing_fields:parse(r.missing_json,[]),missing_json:undefined})));const r=page.results.at(-1)!;resourceCursor=[r.package_name,r.kind,r.version];}
 if((counters.pending_questions??0)>0||(counters.pending_resources??0)>0)throw new Error('Pending work prevents report materialization.');
 const totals:Record<string,number>={};const rows:Row[]=[];let cursor='';
 for(;;){const page=await env.DB.prepare(`SELECT p.*,cr.downloads_30d,cr.likes,cr.points,cr.max_points,cr.metrics_captured_at,cr.metadata_json,cr.score_json,cr.analysis_json FROM review_operation_packages p LEFT JOIN competitor_registry cr ON cr.package_name=p.package_name WHERE p.operation_id=? AND p.package_name>? ORDER BY p.package_name LIMIT 100`).bind(id,cursor).all<Row>();
  if(!page.results.length)break;
  for(const r of page.results){if(r.disposition==='excluded_noise')r.relationship='noise';totals[r.relationship]=(totals[r.relationship]??0)+1;rows.push(r);}cursor=page.results.at(-1)!.package_name;
 }
 const direct=rows.filter(r=>r.relationship==='direct').sort((a,b)=>Number(a.downloads_30d==null)-Number(b.downloads_30d==null)||(b.downloads_30d??0)-(a.downloads_30d??0)||a.package_name.localeCompare(b.package_name));
 const expansions=rows.filter(r=>r.relationship!=='noise'&&(r.relationship==='unknown'||r.relationship==='adjacent'||parse(r.analysis_json).expansion)).sort((a,b)=>Number(a.downloads_30d==null)-Number(b.downloads_30d==null)||(b.downloads_30d??0)-(a.downloads_30d??0)||a.package_name.localeCompare(b.package_name));
 const metricCoverage=rows.filter(r=>['direct','adjacent'].includes(r.relationship));
 const dispositions=rows.reduce((counts:Record<string,number>,r)=>{counts[r.disposition]=(counts[r.disposition]??0)+1;return counts;},{});
 const origins=rows.reduce((counts:Record<string,number>,r)=>{const origin=parse(r.provenance_json).origin??'unrecorded';counts[origin]=(counts[origin]??0)+1;return counts;},{});
 const info={id,product_commit:op.product_commit,counters,totals,dispositions,origins,resource_outcomes:resources,coverage:{discovered:rows.length,enriched:rows.filter(r=>parse(r.metadata_json).version).length,newly_inspected:counters.newly_reviewed??0,reused:rows.filter(r=>['reused','reconciled_reuse'].includes(r.import_status)).length,excluded_noise:rows.filter(r=>r.disposition==='excluded_noise').length,unresolved:totals.unknown??0},metrics:{eligible:metricCoverage.length,downloads_observed:metricCoverage.filter(r=>r.downloads_30d!==null).length},notes};
 const lines=[`# DeeplinkX competitor review ${id}`,'',`Product commit: ${op.product_commit}`,'',`Coverage: ${rows.length} identities. Rankings are among packages with observed downloads; missing values are last.`,'',`Totals: ${Object.entries(totals).map(([k,v])=>`${k}: ${v}`).join(', ')}.`,'','## Review and opportunity findings','',notes.summary??'',...Object.entries(notes).filter(([key])=>key!=='summary').map(([key,v])=>`\n### ${key}\n\n${typeof v==='string'?v:JSON.stringify(v,null,2)}`),'','## Resource gaps','',...resources.filter(r=>r.status==='unavailable').map(r=>`- ${r.package_name}: ${r.kind}; ${r.error??'Unavailable'}; attempts ${r.attempts}.`),'','## Top direct competitors','',...direct.slice(0,10).map(r=>`- [${r.package_name}](https://pub.dev/packages/${r.package_name}): downloads ${r.downloads_30d??'unavailable'}; observed ${r.metrics_captured_at??'unavailable'}`),'','## Top expansion/review candidates','',...expansions.slice(0,10).map(r=>`- [${r.package_name}](https://pub.dev/packages/${r.package_name}): downloads ${r.downloads_30d??'unavailable'}; observed ${r.metrics_captured_at??'unavailable'}`),'','## Relevant and unresolved package accounting','','| Package | Relationship | Disposition | Downloads | Likes | Points | Observed |','|---|---|---|---:|---:|---|---|',...rows.filter(r=>r.relationship!=='noise').map(r=>`| ${r.package_name} | ${r.relationship} | ${r.disposition} | ${r.downloads_30d??'—'} | ${r.likes??'—'} | ${r.points??'—'}/${r.max_points??'—'} | ${r.metrics_captured_at??'—'} |`),'',`Noise: ${totals.noise??0} excluded identities; names/dispositions are available in JSON/CSV without noise metrics.`];
 const exported=rows.map(r=>r.relationship==='noise'?{package_name:r.package_name,relationship:'noise',disposition:r.disposition,origin:parse(r.provenance_json).origin??'production_policy'}:{package_name:r.package_name,relationship:r.relationship,disposition:r.disposition,import_status:r.import_status,metrics:{downloads_30d:r.downloads_30d,likes:r.likes,points:r.points,max_points:r.max_points,observed_at:r.metrics_captured_at},version:parse(r.metadata_json).version??null,published_at:parse(r.metadata_json).published??null,metric_field_dates:parse(r.score_json).field_observed_at??{},analysis:parse(r.analysis_json),original_relationship:parse(r.provenance_json).original_relationship??r.relationship,previous_decision:parse(r.previous_json),result:parse(r.result_json,null),provenance:parse(r.provenance_json)});
 const contents={markdown:lines.join('\n')+'\n',json:JSON.stringify({...info,packages:exported}),csv:['package,relationship,disposition,downloads,likes,points,max_points,observed',...rows.map(r=>[r.package_name,r.relationship,r.disposition,...(r.relationship==='noise'?['','','','','']:[r.downloads_30d,r.likes,r.points,r.max_points,r.metrics_captured_at])].map(csv).join(','))].join('\n')+'\n'};
 for(const [format,content] of Object.entries(contents)) {
  // Rebuild only this unfinished operation; published search exports are never touched.
  await env.DB.prepare('DELETE FROM review_operation_artifacts WHERE operation_id=? AND format=?').bind(id,format).run();
  const encoded=new TextEncoder().encode(content);const decoder=new TextDecoder();let offset=0,index=0;
  do {let end=Math.min(encoded.length,offset+256000);while(end<encoded.length&&(encoded[end]&0xc0)===0x80)end--;
   const part=decoder.decode(encoded.slice(offset,end));
   await env.DB.prepare('INSERT INTO review_operation_artifacts VALUES(?,?,?,?,?,?)').bind(id,format,index++,part,await sha256Hex(part),stamp()).run();offset=end;
  }while(offset<encoded.length);
 }
 const gaps=rows.some(r=>r.relationship==='unknown'||r.import_status==='draft')||(counters.resources_unavailable??0)>0;
 await env.DB.prepare('UPDATE review_operations SET status=?,updated_at=? WHERE id=?').bind(gaps?'complete_with_gaps':'complete',stamp(),id).run();
}
async function requestBody(request:Request):Promise<Row>{if(Number(request.headers.get('content-length')??0)>1000000)throw new Error('Request body exceeds 1 MB.');const encoding=request.headers.get('content-encoding');if(encoding&&encoding!=='gzip')throw new Error('Unsupported content encoding.');
 const source=encoding==='gzip'?request.body?.pipeThrough(new DecompressionStream('gzip')):request.body;
 if(!source)throw new Error('Missing request body.');const reader=source.getReader();const chunks:Uint8Array[]=[];let bytes=0;
 for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>1000000){await reader.cancel();throw new Error('Request body exceeds 1 MB.');}chunks.push(next.value);}
 const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(joined));}
export async function handleReviewOperations(request:Request,env:Env,path:string,key:string):Promise<Response> {
 try {
  const suffix=path.slice(namespace.length).replace(/^\//,'');
  if(!suffix&&request.method==='GET'){const after=new URL(request.url).searchParams.get('after_id')??'';if(after.length>80)throw new Error('Invalid operation cursor.');const rows=await env.DB.prepare('SELECT id,status,scope,product_commit,apply_reviews,counters_json,updated_at FROM review_operations WHERE id>? ORDER BY id LIMIT 20').bind(after).all<Row>();return json({operations:rows.results.map(r=>({...r,counters:parse(r.counters_json),counters_json:undefined})),next_cursor:rows.results.length===20?rows.results.at(-1)?.id:null});}
  if(!suffix&&request.method==='POST')return json(await createReviewOperation(env,key,await requestBody(request)));
  const [id,action]=suffix.split('/');if(!id||!/^[a-z0-9-]{1,80}$/.test(id))return json({error:'Invalid operation ID'},400);
  if(request.method==='GET'&&!action){
   if(new URL(request.url).searchParams.get('provenance_missing')==='1')return json({package_names:(await env.DB.prepare("SELECT package_name FROM review_operation_packages WHERE operation_id=? AND json_extract(provenance_json,'$.source_review_sha256') IS NULL ORDER BY package_name").bind(id).all<Row>()).results.map(r=>r.package_name)});
   if(new URL(request.url).searchParams.get('metrics_missing')==='1')return json({package_names:(await env.DB.prepare("SELECT p.package_name FROM review_operation_packages p JOIN competitor_registry cr ON cr.package_name=p.package_name WHERE p.operation_id=? AND p.relationship IN ('direct','adjacent') AND (cr.downloads_30d IS NULL OR cr.likes IS NULL OR cr.points IS NULL OR cr.max_points IS NULL) ORDER BY p.package_name").bind(id).all<Row>()).results.map(r=>r.package_name)});
   if(new URL(request.url).searchParams.get('membership')==='1')return json({package_names:(await env.DB.prepare('SELECT package_name FROM review_operation_packages WHERE operation_id=? AND bootstrap_complete=1 ORDER BY package_name').bind(id).all<Row>()).results.map(r=>r.package_name)});
   return json(await reviewOperationStatus(env,id));
  }
  if(request.method==='GET'&&action==='report') {
   const op=await operation(env,id);if(!finalStates.includes(op.status))return json({error:'Report is not complete.'},409);
   const format=new URL(request.url).searchParams.get('format')??'markdown';if(!['markdown','json','csv'].includes(format))throw new Error('Invalid report format.');
   const stream=new ReadableStream({async start(controller){let index=0;try{for(;;){const part=await env.DB.prepare('SELECT content,content_hash FROM review_operation_artifacts WHERE operation_id=? AND format=? AND chunk_index=?').bind(id,format,index++).first<Row>();if(!part)break;if(await sha256Hex(part.content)!==part.content_hash)throw new Error('Artifact hash mismatch.');controller.enqueue(new TextEncoder().encode(part.content));}controller.close();}catch(error){controller.error(error);}}});
   return new Response(stream,{headers:{'cache-control':'no-store','content-type':format==='json'?'application/json':format==='csv'?'text/csv; charset=utf-8':'text/markdown; charset=utf-8'}});
  }
  if(request.method!=='POST')return json({error:'Unsupported operation route'},404);
  await operation(env,id);
  const body=await requestBody(request);
  const result=await receipt(env,id,`${action}:${key}`,body,async()=>{
   if(action==='bootstrap')return bootstrapReviewOperation(env,id,body as any);
   if(action==='claim')return claimReviewPacket(env,id,key,body);
   if(action==='evidence')return reviewEvidence(env,id,body);
   if(action==='results')return submitReviewResults(env,id,body);
   if(action==='finalize')return finalizeReviewOperation(env,id,body);
   throw new Error('Unsupported operation action.');
  });return json(result);
 } catch(error){if(isD1DailyQuotaError(error))throw error;return json({error:error instanceof Error?error.message:'Invalid operation'},400);}
}

/** Routine scores use their own resource phase; no metadata/README refresh. */
export async function scheduleRoutineMetrics(env:Env,key:string,name:string):Promise<void> {
 if((await policyFor(env,name))?.state==='confirmed_noise')return;
 const row=await env.DB.prepare('SELECT relationship,metrics_captured_at FROM competitor_registry WHERE package_name=?').bind(name).first<Row>();
 if(!row||!['direct','adjacent'].includes(row.relationship))return;
 if(row.metrics_captured_at && Date.now()-Date.parse(row.metrics_captured_at)<30*86400000)return;
 const created=await createReviewOperation(env,`routine-metrics:${key}`,{stop_on_quota:false}) as Row;
 const op=await operation(env,created.id);if(finalStates.includes(op.status))return;
 await env.DB.prepare("INSERT OR IGNORE INTO review_operation_packages(operation_id,package_name,disposition,relationship,provenance_json,bootstrap_complete,updated_at) VALUES(?,?,'reuse',?,'{}',1,?)").bind(op.id,name,row.relationship,stamp()).run();
 await event(env,op.id,`member:${name}`,{packages:1});
 // Routine refresh may replace >30-day observations, closeouts otherwise reuse them.
 await scheduleReviewResource(env,op.id,name,'metrics');
}
export async function recordObservedUpdate(env:Env,name:string,baseline:string,version:string):Promise<void> {
 if(!baseline||baseline===version||(await policyFor(env,name))?.state==='confirmed_noise')return;
 const result=await createReviewOperation(env,`observed-update:${name}:${baseline}:${version}`,{stop_on_quota:false}) as Row;
 if(finalStates.includes((await operation(env,result.id)).status))return;
 await bootstrapReviewOperation(env,result.id,{packages:[{package_name:name}]});
 await scheduleReviewResource(env,result.id,name,'changelog',`Need relevant additions since reviewed version ${baseline}; observed version ${version}.`);
}
