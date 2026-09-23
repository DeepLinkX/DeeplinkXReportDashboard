import { sha256Hex, stableJson } from '../shared/catalog.js';
import type { PackageAnalysis } from '../shared/intelligence.js';

export const REVIEW_SCOPE = 'external-app-actions-v1';
export const REVIEW_POLICY_VERSION = 'external-app-mapping-v2';
export type EvidenceRow = Record<string, unknown>;
export interface ReviewPolicy {
  package_name: string; state: 'confirmed_noise' | 'active' | 'reopened'; scope: string;
  policy_version: string; semantic_fingerprint: string; metadata_json: string;
  documentation_text: string; decision_json: string; product_commit: string;
  reason: string; reviewed_by: string; confirmed_at: string; reopened_at: string | null; reopen_reason: string | null;
}

export function storedDocumentation(row: EvidenceRow): string {
  const metadata = JSON.parse(String(row.metadata_json || '{}'));
  return row.documentation_version === metadata.version ? String(row.documentation_text ?? '') : '';
}

export async function semanticFingerprint(row: EvidenceRow): Promise<string> {
  const m = JSON.parse(String(row.metadata_json || '{}'));
  return sha256Hex(stableJson({ scope: REVIEW_SCOPE, metadata: {
    name: m.name ?? row.package_name, version: m.version ?? null,
    description: m.description ?? '', topics: [...(m.topics ?? [])].sort(), repository: m.repository ?? null,
  }, documentation: storedDocumentation(row).replace(/\s+/g, ' ').trim() }));
}

/** Name-only rediscovery never changes this predicate. No score/age/classifier fields participate. */
export const unchangedNoiseSql = (alias = 'cr') => `EXISTS (SELECT 1 FROM competitor_review_policies rp
 WHERE rp.package_name=${alias}.package_name AND rp.state='confirmed_noise' AND rp.scope='${REVIEW_SCOPE}'
 AND json_extract(rp.metadata_json,'$.version') IS json_extract(${alias}.metadata_json,'$.version')
 AND json_extract(rp.metadata_json,'$.description') IS json_extract(${alias}.metadata_json,'$.description')
 AND COALESCE((SELECT json_group_array(value ORDER BY value) FROM json_each(COALESCE(json_extract(rp.metadata_json,'$.topics'),'[]'))),'[]')
     =COALESCE((SELECT json_group_array(value ORDER BY value) FROM json_each(COALESCE(json_extract(${alias}.metadata_json,'$.topics'),'[]'))),'[]')
 AND json_extract(rp.metadata_json,'$.repository') IS json_extract(${alias}.metadata_json,'$.repository')
 AND rp.documentation_text=CASE WHEN ${alias}.documentation_version=json_extract(${alias}.metadata_json,'$.version') THEN COALESCE(${alias}.documentation_text,'') ELSE '' END)`;

export async function policyFor(env: Env, name: string): Promise<ReviewPolicy | null> {
  return env.DB.prepare('SELECT * FROM competitor_review_policies WHERE package_name=?').bind(name).first<ReviewPolicy>();
}

export async function applicablePolicy(env: Env, row: EvidenceRow, productCommit: string): Promise<{ policy: ReviewPolicy | null; decision: PackageAnalysis | null; skippedNoise: boolean }> {
  const policy = await policyFor(env, String(row.package_name));
  if (!policy || policy.state === 'reopened') return { policy, decision: null, skippedNoise: false };
  const changed = policy.scope !== REVIEW_SCOPE || policy.semantic_fingerprint !== await semanticFingerprint(row);
  if (changed) {
    await env.DB.prepare("UPDATE competitor_review_policies SET state='reopened',reopened_at=?,reopen_reason='Observed semantic evidence or scope changed' WHERE package_name=? AND state!='reopened'")
      .bind(new Date().toISOString(), row.package_name).run();
    await env.DB.prepare("UPDATE competitor_registry SET processing_status='pending_review' WHERE package_name=?").bind(row.package_name).run();
    return { policy: { ...policy, state: 'reopened' }, decision: null, skippedNoise: false };
  }
  const skippedNoise = policy.state === 'confirmed_noise';
  const decision = skippedNoise || (policy.product_commit === productCommit && policy.policy_version === REVIEW_POLICY_VERSION)
    ? JSON.parse(policy.decision_json) as PackageAnalysis : null;
  return { policy, decision, skippedNoise };
}

/** Guard resource fields as collectors persist them before recomputing evidence_hash. */
export function evidenceSnapshot(row: EvidenceRow): { sql: string; values: Array<string | null> } {
  const fields = ['evidence_hash', 'product_commit', 'metadata_json', 'documentation_text', 'documentation_version'];
  return { sql: fields.map(field => `${field} IS ?`).join(' AND '),
    values: fields.map(field => row[field] == null ? null : String(row[field])) };
}

export async function reviewPolicyStatement(env: Env, row: EvidenceRow, decision: PackageAnalysis, reviewedBy: string, productCommit: string): Promise<D1PreparedStatement> {
  const stamp = new Date().toISOString();
  const snapshot = evidenceSnapshot(row);
  return env.DB.prepare(`INSERT INTO competitor_review_policies(package_name,state,scope,policy_version,semantic_fingerprint,metadata_json,documentation_text,decision_json,product_commit,reason,reviewed_by,confirmed_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,? FROM competitor_registry WHERE package_name=? AND ${snapshot.sql}
    ON CONFLICT(package_name) DO UPDATE SET state=excluded.state,scope=excluded.scope,policy_version=excluded.policy_version,
    semantic_fingerprint=excluded.semantic_fingerprint,metadata_json=excluded.metadata_json,documentation_text=excluded.documentation_text,
    decision_json=excluded.decision_json,product_commit=excluded.product_commit,reason=excluded.reason,reviewed_by=excluded.reviewed_by,
    confirmed_at=excluded.confirmed_at,reopened_at=NULL,reopen_reason=NULL`)
    .bind(row.package_name, decision.relationship === 'noise' ? 'confirmed_noise' : 'active', REVIEW_SCOPE, REVIEW_POLICY_VERSION,
      await semanticFingerprint(row), String(row.metadata_json), storedDocumentation(row), JSON.stringify(decision), productCommit,
      decision.rationale, reviewedBy, stamp, row.package_name, ...snapshot.values);
}

export async function reopenReview(env: Env, names: string[], reason: string): Promise<unknown> {
  const stamp = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE competitor_review_policies SET state='reopened',reopened_at=?,reopen_reason=? WHERE package_name IN (SELECT value FROM json_each(?))")
      .bind(stamp, reason, JSON.stringify(names)),
    env.DB.prepare("UPDATE competitor_registry SET processing_status='pending_review' WHERE package_name IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(names)),
  ]);
  return { status: 'reopened', packages: names, queued: false };
}
