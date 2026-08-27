import bundledCatalog from "../../catalog/catalog-v3.json";
import { sha256Hex, stableJson, validateCatalog } from "../shared/catalog.js";
import type { AuditProfile, CatalogManifest, QueryDefinition } from "../shared/types.js";

const SQL_CHUNK = 75;

function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

async function definitionHash(query: QueryDefinition): Promise<string> {
  return sha256Hex(stableJson({
    query: query.query,
    lane: query.lane,
    product_area: query.product_area,
    expression_type: query.expression_type,
    product_fit: query.product_fit,
    tags: query.tags,
    sources: query.sources,
  }));
}

export async function storeCatalog(
  env: Env,
  candidate: unknown,
  activate: boolean,
): Promise<CatalogManifest> {
  const catalog = await validateCatalog(candidate);
  const now = new Date().toISOString();
  const content = stableJson(catalog);
  const contentHash = await sha256Hex(content);

  await env.DB.prepare(
    `INSERT INTO catalogs (
      catalog_version, schema_version, catalog_revision, source_commit, source_url,
      content_hash, content_json, pulse_count, full_count, created_at, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(catalog_version) DO UPDATE SET
      source_commit = excluded.source_commit,
      source_url = excluded.source_url,
      content_hash = excluded.content_hash,
      content_json = excluded.content_json,
      pulse_count = excluded.pulse_count,
      full_count = excluded.full_count`,
  ).bind(
    catalog.catalog_version,
    catalog.schema_version,
    catalog.catalog_revision,
    catalog.source_commit,
    catalog.source_url,
    contentHash,
    content,
    catalog.selection.profile_counts.pulse,
    catalog.selection.profile_counts.full,
    now,
  ).run();

  const statements = await Promise.all(catalog.queries.map(async (query) => env.DB.prepare(
    `INSERT INTO queries (
      catalog_version, query_id, query, lane, product_area, expression_type,
      profiles_json, product_fit, tags_json, sources_json, definition_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(catalog_version, query_id) DO UPDATE SET
      query = excluded.query,
      lane = excluded.lane,
      product_area = excluded.product_area,
      expression_type = excluded.expression_type,
      profiles_json = excluded.profiles_json,
      product_fit = excluded.product_fit,
      tags_json = excluded.tags_json,
      sources_json = excluded.sources_json,
      definition_hash = excluded.definition_hash`,
  ).bind(
    catalog.catalog_version,
    query.query_id,
    query.query,
    query.lane,
    query.product_area,
    query.expression_type,
    JSON.stringify(query.profiles),
    query.product_fit,
    JSON.stringify(query.tags),
    JSON.stringify(query.sources),
    await definitionHash(query),
  )));
  for (const group of chunks(statements, SQL_CHUNK)) await env.DB.batch(group);

  if (activate) {
    await env.DB.batch([
      env.DB.prepare("UPDATE catalogs SET is_active = 0 WHERE is_active = 1"),
      env.DB.prepare("UPDATE catalogs SET is_active = 1, activated_at = ? WHERE catalog_version = ?").bind(now, catalog.catalog_version),
      env.DB.prepare(
        `INSERT INTO system_state (key, value_json, updated_at) VALUES ('catalog_sync', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ).bind(JSON.stringify({ status: "current", catalog_version: catalog.catalog_version, source: catalog.source_url }), now),
    ]);
  }
  return catalog;
}

export async function activeCatalog(env: Env): Promise<CatalogManifest> {
  const row = await env.DB.prepare("SELECT content_json FROM catalogs WHERE is_active = 1").first<{ content_json: string }>();
  if (row) return validateCatalog(JSON.parse(row.content_json));
  return storeCatalog(env, bundledCatalog, true);
}

/** Explicitly activate the catalog bundled with this deployed Worker version. */
export async function activateBundledCatalog(env: Env): Promise<CatalogManifest> {
  return storeCatalog(env, bundledCatalog, true);
}

export async function syncCatalog(env: Env): Promise<{ catalog: CatalogManifest; warning: string | null }> {
  const now = new Date().toISOString();
  try {
    const response = await fetch(env.CATALOG_URL, {
      headers: { accept: "application/json", "user-agent": "deeplinkx-visibility/1.0" },
    });
    if (!response.ok) throw new Error(`Catalog source returned HTTP ${response.status}.`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 2_000_000) throw new Error("Catalog source exceeded the 2 MB limit.");
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error("Catalog source exceeded the 2 MB limit.");
    const catalog = await storeCatalog(env, JSON.parse(text), true);
    return { catalog, warning: null };
  } catch (error) {
    const catalog = await activeCatalog(env);
    const warning = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(
      `INSERT INTO system_state (key, value_json, updated_at) VALUES ('catalog_sync', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify({ status: "stale", catalog_version: catalog.catalog_version, warning }), now).run();
    return { catalog, warning };
  }
}

export function selectCatalogQueries(catalog: CatalogManifest, profile: AuditProfile): QueryDefinition[] {
  if (profile === "legacy-mixed") return [];
  return catalog.queries.filter((query) => query.profiles.includes(profile));
}
