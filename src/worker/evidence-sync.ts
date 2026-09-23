import bundledCatalog from '../../catalog/catalog-v3.json';
import { ANALYSIS_VERSION } from '../shared/competitor-analysis.js';
import { sha256Hex, stableJson } from '../shared/catalog.js';
import { applicablePolicy, policyFor, evidenceSnapshot, REVIEW_SCOPE, REVIEW_POLICY_VERSION, type EvidenceRow } from './review-policy.js';

export function packageNames(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 10 || value.some(n => typeof n !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(n)) || new Set(value).size !== value.length) {
    throw new Error('Select 1–10 unique valid package names.');
  }
  return value;
}

export async function policyPreview(env: Env, names: string[]): Promise<unknown> {
  const packages = [];
  for (const name of packageNames(names)) {
    const row = await env.DB.prepare('SELECT * FROM competitor_registry WHERE package_name=?').bind(name).first<EvidenceRow>();
    const policy = await policyFor(env, name);
    packages.push({ package_name: name, evidence_hash: row?.evidence_hash ?? null, product_commit: row?.product_commit ?? null,
      metadata: row?.metadata_json ? JSON.parse(String(row.metadata_json)) : null,
      documentation_version: row?.documentation_version ?? null,
      documentation_sha256: await sha256Hex(String(row?.documentation_text ?? '')),
      policy: policy ? { state: policy.state, scope: policy.scope, semantic_fingerprint: policy.semantic_fingerprint,
        reason: policy.reason, reopened_at: policy.reopened_at, reopen_reason: policy.reopen_reason } : null });
  }
  return { scope: REVIEW_SCOPE, policy_version: REVIEW_POLICY_VERSION, product_commit: bundledCatalog.source_commit, packages };
}

interface EvidenceInput {
  package_name: string; expected_evidence_hash: string | null; product_commit: string;
  metadata: {name: string; version: string; published: string | null; description: string; topics: string[]; repository: string | null};
  documentation: string; observed_at: string;
  sources: Array<{url: string; sha256: string; observed_at: string; reason: string}>;
}

const timestamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && Date.parse(v) <= Date.now() + 300000;
const https = (v: unknown) => {try {const u=new URL(String(v));return u.protocol==='https:' && !u.username && !u.password;} catch{return false;}};

/** Maintainer-supplied frozen evidence only. Never fetch a submitted URL. */
export async function syncEvidence(env: Env, body: { packages: EvidenceInput[]; dry_run?: boolean }): Promise<unknown> {
  if (!body || !Array.isArray(body.packages)) throw new Error('packages must be an array.');
  packageNames(body.packages.map(p => p?.package_name));
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') throw new Error('dry_run must be boolean.');
  for (const p of body.packages) {
    const m = p.metadata;
    if (!m || m.name !== p.package_name || typeof m.version !== 'string' || !/^[0-9][0-9A-Za-z.+-]{0,99}$/.test(m.version)
      || (m.published !== null && !timestamp(m.published)) || typeof m.description !== 'string' || m.description.length > 20000
      || !Array.isArray(m.topics) || m.topics.length > 100 || m.topics.some(t => typeof t !== 'string' || t.length > 200)
      || (m.repository !== null && !https(m.repository)) || typeof p.documentation !== 'string' || p.documentation.length > 150000
      || !timestamp(p.observed_at) || p.product_commit !== bundledCatalog.source_commit
      || !(p.expected_evidence_hash === null || typeof p.expected_evidence_hash === 'string' && /^(?:[a-f0-9]{64})?$/.test(p.expected_evidence_hash))
      || !Array.isArray(p.sources) || !p.sources.length || p.sources.length > 20
      || p.sources.some(s => !https(s.url) || !/^[a-f0-9]{64}$/.test(s.sha256) || !timestamp(s.observed_at) || typeof s.reason !== 'string' || !s.reason.trim() || s.reason.length > 1000)) {
      throw new Error(`Invalid versioned evidence or provenance: ${p.package_name}`);
    }
  }
  const results = [];
  for (const p of body.packages) {
    const row = await env.DB.prepare('SELECT * FROM competitor_registry WHERE package_name=?').bind(p.package_name).first<EvidenceRow>();
    const current = JSON.parse(String(row?.metadata_json || '{}'));
    const metadata = { name: p.metadata.name, version: p.metadata.version, published: p.metadata.published,
      description: p.metadata.description, topics: p.metadata.topics, repository: p.metadata.repository };
    const hash = await sha256Hex(stableJson({metadata, documentation: p.documentation, classifier: ANALYSIS_VERSION}));
    if (row?.evidence_hash === hash && row?.product_commit === p.product_commit) {
      results.push({ package_name: p.package_name, status: 'unchanged', evidence_hash: hash, product_commit: p.product_commit }); continue;
    }
    const differingCurrent = current.version && (stableJson(current) !== stableJson(metadata) || (row?.documentation_text && row.documentation_text !== p.documentation));
    if ((row?.evidence_hash ?? null) !== p.expected_evidence_hash || (current.version && current.version !== metadata.version)
      || (differingCurrent && String(row?.metadata_captured_at ?? '') > p.observed_at)
      || (row?.documentation_text && !p.documentation)
      || (row?.documentation_text && row.documentation_text !== p.documentation && String(row.documentation_captured_at ?? '') > p.observed_at)) {
      results.push({ package_name: p.package_name, status: 'conflict', reason: 'Production evidence differs or is newer; review before synchronizing.' }); continue;
    }
    if (body.dry_run !== false) { results.push({ package_name: p.package_name, status: 'would_sync', evidence_hash: hash, product_commit: p.product_commit }); continue; }
    const stamp = new Date().toISOString();
    // Admission is protected; CAS prevents overwriting a concurrent collector/review.
    await env.DB.prepare(`INSERT OR IGNORE INTO competitor_registry(package_name,first_seen_at,updated_at) VALUES(?,?,?)`).bind(p.package_name, stamp, stamp).run();
    const snapshot = evidenceSnapshot(row ?? { evidence_hash: '', product_commit: '', metadata_json: null, documentation_text: null, documentation_version: null });
    const result = await env.DB.prepare(`UPDATE competitor_registry SET metadata_json=?,metadata_captured_at=?,published_at=?,documentation_text=?,documentation_version=?,
      documentation_captured_at=?,evidence_sources_json=?,evidence_hash=?,product_commit=?,classifier_version=?,processing_status='pending_review',updated_at=?
      WHERE package_name=? AND ${snapshot.sql}`)
      .bind(JSON.stringify(metadata), p.observed_at, metadata.published, p.documentation, metadata.version, p.documentation ? p.observed_at : null,
        JSON.stringify(p.sources), hash, p.product_commit, ANALYSIS_VERSION, stamp, p.package_name, ...snapshot.values).run();
    if (!result.meta.changes) { results.push({ package_name: p.package_name, status: 'conflict', reason: 'Evidence changed concurrently.' }); continue; }
    const updated = (await env.DB.prepare('SELECT * FROM competitor_registry WHERE package_name=?').bind(p.package_name).first<EvidenceRow>())!;
    await applicablePolicy(env, updated, p.product_commit);
    results.push({ package_name: p.package_name, status: 'synced', evidence_hash: hash, product_commit: p.product_commit });
  }
  return { dry_run: body.dry_run !== false, results };
}

export async function processingCounters(env: Env): Promise<unknown> {
  const results = await env.DB.batch([
    env.DB.prepare('SELECT state,COUNT(*) AS count FROM competitor_review_policies GROUP BY state'),
    env.DB.prepare('SELECT processing_status,COUNT(*) AS count FROM competitor_registry GROUP BY processing_status'),
    env.DB.prepare('SELECT status,outcome,COUNT(*) AS count FROM intelligence_jobs GROUP BY status,outcome'),
  ]);
  return { policies: results[0].results, packages: results[1].results, jobs: results[2].results };
}
