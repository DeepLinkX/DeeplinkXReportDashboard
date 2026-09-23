import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, afterEach, it, expect, vi } from 'vitest';
import catalog from '../catalog/catalog-v3.json';
import { refreshPackage, importReview, startIntelligence, processIntelligenceJob } from '../src/worker/intelligence.js';
import { syncEvidence, policyPreview } from '../src/worker/evidence-sync.js';
import { reopenReview, semanticFingerprint } from '../src/worker/review-policy.js';
import { sha256Hex } from '../src/shared/catalog.js';
import type { PackageAnalysis } from '../src/shared/intelligence.js';

vi.mock('../src/worker/pubdev.js', async original => ({
  ...await original<typeof import('../src/worker/pubdev.js')>(), beforePubdevRequest: vi.fn(), recordPubdevThrottle: vi.fn(),
}));
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(() => vi.restoreAllMocks());

const noise: PackageAnalysis = {relationship:'noise',capability_category:'UI',rationale:'In-app draggable menu only.',capabilities:[],providers:[],actions:[],migration_status:'unsupported',expansion:false,review_status:'reviewed'};
const evidence = async (name: string, description = 'An in-app draggable menu') => ({
  package_name:name, expected_evidence_hash:null, product_commit:catalog.source_commit,
  metadata:{name,version:'1.0.0',published:'2022-01-01T00:00:00Z',description,topics:[],repository:null},
  documentation:'',observed_at:new Date().toISOString(),
  sources:[{url:`https://pub.dev/api/packages/${name}`,sha256:await sha256Hex(description),observed_at:new Date().toISOString(),reason:'Frozen published package metadata'}],
});
async function confirm(name: string, description?: string) {
  const input = await evidence(name,description);
  const existing = await env.DB.prepare('SELECT evidence_hash FROM competitor_registry WHERE package_name=?').bind(name).first<{evidence_hash:string}>();
  (input as {expected_evidence_hash:string|null}).expected_evidence_hash = existing?.evidence_hash ?? null;
  const result = await syncEvidence(env,{packages:[input],dry_run:false}) as {results:Array<{evidence_hash:string}>};
  await importReview(env,{package_name:name,evidence_hash:result.results[0].evidence_hash,product_commit:catalog.source_commit,reviewed_by:'test reviewer',decision:noise});
  return input;
}

it('skips all resources for confirmed noise, retaining old metrics despite classifier/product/age changes',async()=>{
  await confirm('noise_keep');
  await env.DB.prepare("UPDATE competitor_registry SET metrics_captured_at='2020-01-01',metadata_captured_at='2020-01-01',downloads_30d=77,score_json=?,classifier_version='old',product_commit='old' WHERE package_name='noise_keep'").bind(JSON.stringify({downloads_30d:77})).run();
  const fetcher=vi.spyOn(globalThis,'fetch');
  const result=await refreshPackage(env,'noise_keep',10,undefined,new Date().toISOString(),true);
  expect(fetcher).not.toHaveBeenCalled();
  expect(result).toMatchObject({relationship:'noise',downloads_30d:77,processing_status:'skipped_noise',metrics_captured_at:'2020-01-01'});
});

it('excludes noise at full/weekly admission and skips stale queued jobs',async()=>{
  await confirm('noise_queued');
  await env.DB.prepare("UPDATE competitor_registry SET downloads_30d=50000 WHERE package_name='noise_queued'").run();
  vi.spyOn(env.SCAN_QUEUE,'send').mockResolvedValue(undefined);
  await startIntelligence(env,'noise_weekly',undefined,false);
  await startIntelligence(env,'noise_monthly',undefined,true);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM intelligence_jobs WHERE subject='noise_queued'").first()).toEqual({n:0});
  await env.DB.prepare("INSERT INTO intelligence_jobs(id,kind,subject,status,created_at,updated_at) VALUES('old_noise','package','noise_queued','queued','2020','2020')").run();
  const fetcher=vi.spyOn(globalThis,'fetch');
  await processIntelligenceJob(env,'old_noise',1);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await env.DB.prepare("SELECT status,outcome FROM intelligence_jobs WHERE id='old_noise'").first()).toEqual({status:'complete',outcome:'skipped_noise'});
});

it('name-only supplemental discovery stores position without enqueuing noise',async()=>{
  await confirm('noise_discovery');
  vi.spyOn(env.SCAN_QUEUE,'send').mockResolvedValue(undefined);
  await env.DB.prepare("INSERT INTO intelligence_jobs(id,kind,subject,created_at,updated_at) VALUES('noise_search','search','menu','2020','2020')").run();
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({packages:[{package:'noise_discovery'}]}));
  await processIntelligenceJob(env,'noise_search',1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM intelligence_jobs WHERE kind='package' AND subject='noise_discovery'").first()).toEqual({n:0});
  expect(await env.DB.prepare("SELECT position FROM competitor_discoveries WHERE package_name='noise_discovery'").first()).toEqual({position:1});
});

it('reopens observed version changes and explicit reopen without restoring obsolete reviewed noise',async()=>{
  await confirm('noise_changed');
  await env.DB.prepare("UPDATE competitor_registry SET metadata_json=json_set(metadata_json,'$.version','2.0.0','$.description','Share WhatsApp text'),documentation_text='Share WhatsApp text',documentation_version='2.0.0' WHERE package_name='noise_changed'").run();
  vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({downloadCount30Days:3}));
  expect((await refreshPackage(env,'noise_changed')).relationship).toBe('direct');
  expect(await env.DB.prepare("SELECT state FROM competitor_review_policies WHERE package_name='noise_changed'").first()).toEqual({state:'reopened'});
  await confirm('noise_explicit','Share WhatsApp text');
  await reopenReview(env,['noise_explicit'],'Maintainer found outbound behavior');
  await env.DB.prepare("UPDATE competitor_registry SET documentation_text='Share WhatsApp text',documentation_version='1.0.0' WHERE package_name='noise_explicit'").run();
  expect((await refreshPackage(env,'noise_explicit')).relationship).toBe('direct');
});

it('new noise never fetches a score even with plausible provider terms',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch')
    .mockResolvedValueOnce(Response.json({name:'new_noise',latest:{version:'1.0.0',pubspec:{description:'WhatsApp chat bubbles UI',topics:[]}}}))
    .mockResolvedValueOnce(new Response('<section class="detail-tab-readme">WhatsApp chat bubbles UI widgets</section>'));
  expect((await refreshPackage(env,'new_noise')).relationship).toBe('noise');
  expect(fetcher.mock.calls.every(([url])=>!String(url).endsWith('/score'))).toBe(true);
});

it('uses reviewed noise before metrics even when automatic analysis and seeds look relevant',async()=>{
  await confirm('whatsapp_unilink','Share WhatsApp text and links');
  const fetcher=vi.spyOn(globalThis,'fetch');
  expect((await refreshPackage(env,'whatsapp_unilink')).relationship).toBe('noise');
  expect(fetcher).not.toHaveBeenCalled();
});

it('retains usable same-version documents regardless of age',async()=>{
  const input=await evidence('old_docs','Share WhatsApp text');input.documentation='Share WhatsApp text';
  await syncEvidence(env,{packages:[input],dry_run:false});
  await env.DB.prepare("UPDATE competitor_registry SET documentation_captured_at='2020-01-01' WHERE package_name='old_docs'").run();
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({downloadCount30Days:4}));
  await refreshPackage(env,'old_docs');
  expect(fetcher).toHaveBeenCalledTimes(1);expect(String(fetcher.mock.calls[0][0])).toMatch(/\/score$/);
});

it('bounds unresolved weekly candidates and never admits noise because it has downloads',async()=>{
  vi.spyOn(env.SCAN_QUEUE,'send').mockResolvedValue(undefined);
  await env.DB.prepare(`WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<110)
    INSERT INTO competitor_registry(package_name,first_seen_at,updated_at) SELECT 'unresolved_'||x,'2020','2020' FROM n`).run();
  await startIntelligence(env,'bounded_unresolved',undefined,false);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM intelligence_jobs WHERE id LIKE 'bounded_unresolved:unresolved:%'").first()).toEqual({n:100});
});

it('sync previews do not mutate, computes hashes server-side, rejects conflicting versions and invalid batches',async()=>{
  const p=await evidence('sync_guard');
  await syncEvidence(env,{packages:[p]});
  expect(await env.DB.prepare("SELECT package_name FROM competitor_registry WHERE package_name='sync_guard'").first()).toBeNull();
  const first=await syncEvidence(env,{packages:[p],dry_run:false}) as {results:Array<{evidence_hash:string}>};
  expect(first.results[0].evidence_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(await syncEvidence(env,{packages:[p],dry_run:false})).toMatchObject({results:[{status:'unchanged'}]});
  const changed={...p,expected_evidence_hash:first.results[0].evidence_hash,metadata:{...p.metadata,version:'0.9.0'}};
  expect(await syncEvidence(env,{packages:[changed],dry_run:false})).toMatchObject({results:[{status:'conflict'}]});
  await expect(syncEvidence(env,{packages:Array(11).fill(p),dry_run:false})).rejects.toThrow();
  await expect(syncEvidence(env,{packages:[{...p,sources:[]}],dry_run:false})).rejects.toThrow();
  expect(await policyPreview(env,['sync_guard'])).toMatchObject({packages:[{package_name:'sync_guard',evidence_hash:first.results[0].evidence_hash}]});
  await expect(importReview(env,{package_name:'sync_guard',evidence_hash:first.results[0].evidence_hash,product_commit:catalog.source_commit,reviewed_by:'test',decision:{...noise,relationship:'unknown',review_status:'needs_review'}})).rejects.toThrow(/drafts/);
});

it('semantic fingerprint ignores scores, timestamps, classifier and product changes',async()=>{
  const row={package_name:'fingerprint',metadata_json:JSON.stringify((await evidence('fingerprint')).metadata),documentation_version:'1.0.0',documentation_text:'same docs'};
  expect(await semanticFingerprint(row)).toBe(await semanticFingerprint({...row,score_json:'{"downloads_30d":9}',metadata_captured_at:'later',product_commit:'new',classifier_version:'new'}));
});

it('protects policy and evidence operations',async()=>{
  for(const path of ['policy/preview','policy/reopen','evidence/sync','processing']) {
    expect((await SELF.fetch(`https://test/api/v1/admin/competitors/${path}`,{method:'POST',body:'{}'})).status).toBe(401);
  }
});
