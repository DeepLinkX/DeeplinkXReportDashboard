import type { CompetitorRelationship } from "./types.js";

export interface ProductCapability {
  id: string;
  provider: string;
  kind: "app" | "store";
  action: string;
  api: string;
  phrases: string[];
  platforms: string[];
  source: string;
  documentation: string;
  documentation_warnings: string[];
  query_ids: string[];
}

export interface CapabilityMatch {
  provider: string;
  action: string;
  evidence: string;
  source_url: string;
  deeplinkx_apis: string[];
  migration: "partial" | "unsupported" | "needs_review" | "supported";
  caveats: string[];
}

export interface PackageAnalysis {
  relationship: CompetitorRelationship;
  capability_category: string;
  rationale: string;
  capabilities: CapabilityMatch[];
  providers: string[];
  actions: string[];
  migration_status: CapabilityMatch["migration"];
  expansion: boolean;
  review_status: "rule_matched" | "needs_review" | "reviewed";
}

export interface IntelligencePackage extends PackageAnalysis {
  package_name: string;
  published_version: string | null;
  published_at: string | null;
  description: string;
  topics: string[];
  platforms: string[];
  downloads_30d: number | null;
  likes: number | null;
  points: number | null;
  max_points: number | null;
  metadata_captured_at: string | null;
  metrics_captured_at: string | null;
  documentation_captured_at: string | null;
  evidence_hash: string;
  product_commit: string;
  classifier_version: string;
  refresh_status: string;
  metadata_error: string | null;
  metrics_error: string | null;
  documentation_error: string | null;
  relevant_occurrence_count: number;
  relevant_best_rank: number | null;
  last_seen_at: string | null;
}

export const DIRECTORY_SORTS = ["downloads", "likes", "score", "published", "appearances", "rank", "name"] as const;
export const DIRECTORY_FILTERS = ["view", "provider", "action", "platform", "relationship", "migration", "review", "age_months", "q", "sort", "order", "page", "limit"] as const;
