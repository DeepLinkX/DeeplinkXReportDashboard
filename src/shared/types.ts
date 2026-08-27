export type AuditProfile = "pulse" | "full" | "legacy-mixed";
export type ExpressionType = "raw" | "sdk-filter" | "topic-filter";
export type ProductFit = "high" | "medium" | "low";
export type RecommendationClass =
  | "protect"
  | "metadata gap"
  | "authority gap"
  | "capability gap"
  | "noise";

export interface QuerySource {
  type: "fixed-catalog" | "pubdev-syntax" | "repo" | "legacy";
  location: string;
  derivation: string;
}

export interface QueryDefinition {
  query_id: string;
  query: string;
  lane: string;
  product_area: string;
  expression_type: ExpressionType;
  profiles: Array<"pulse" | "full">;
  sources: QuerySource[];
  product_fit: ProductFit;
  tags: Record<string, string>;
  catalog_version: string;
}

export interface CatalogManifest {
  schema_version: 3;
  catalog_revision: string;
  catalog_version: string;
  package: "deeplink_x";
  generated_at: string;
  source_commit: string;
  source_url: string;
  product: {
    repository_version: string;
    repository_description: string;
    topics: string[];
    apps: string[];
    stores: string[];
    navigation_providers: string[];
    hero_apps: string[];
    new_providers: string[];
  };
  selection: {
    profiles: {
      pulse: { depth: 10; description: string };
      full: { depth: 100; description: string };
    };
    profile_counts: { pulse: number; full: number };
    fixed_raw_count: 48;
    fixed_structured_count: 10;
  };
  queries: QueryDefinition[];
  counts: {
    queries: number;
    apps: number;
    stores: number;
    navigation_providers: number;
  };
}

export interface ScanQueryMessage {
  kind: "scan-query";
  runId: string;
  queryId: string;
}

export interface FinalizeRunMessage {
  kind: "finalize-run";
  runId: string;
}

export type AuditQueueMessage = ScanQueryMessage | FinalizeRunMessage;

export interface SearchPackage {
  package: string;
}

export interface SearchPayload {
  packages: SearchPackage[];
}

export interface RunQueryRecord {
  run_id: string;
  query_id: string;
  query: string;
  lane: string;
  product_area: string;
  expression_type: ExpressionType;
  product_fit: ProductFit;
  tags_json: string;
  sources_json: string;
  requested_depth: number;
  actual_depth: number;
  rank: number | null;
  pages_scanned: number;
  next_page: number;
  exhausted: number;
  status: string;
  retry_count: number;
  packages_json: string;
}

export interface LegacyImportPayload {
  schema_version: 3;
  document: {
    id: string;
    document_type: "visibility" | "comparison";
    filename: string;
    report_date: string | null;
    source_path: string;
    source_hash: string;
    content: string;
    provenance: Record<string, unknown>;
  };
  run?: {
    id: string;
    profile: "pulse" | "full" | "legacy-mixed";
    report_date: string;
    requested_depth: number;
    effective_depth: number | null;
    rows: Array<{
      query_id: string;
      query: string;
      lane: string;
      product_area: string;
      expression_type: string;
      product_fit: string;
      tags: Record<string, string>;
      sources: Array<Record<string, string>>;
      definition_hash: string;
      requested_depth: number;
      actual_depth: number;
      rank: number | null;
      exhausted: boolean;
      packages: string[];
      provenance: Record<string, unknown>;
    }>;
    snapshot: {
      published_version: string | null;
      published_at: string | null;
      published_description: string | null;
      published_topics: string[];
      repository_version: string | null;
      repository_description: string | null;
      points: number | null;
      max_points: number | null;
      likes: number | null;
      downloads_30d: number | null;
    };
    ignored_baseline_rows: number;
    unmatched_rows: number;
  };
}
