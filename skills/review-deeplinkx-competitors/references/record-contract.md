# Review records and import compatibility

Normal operation state and results live in Cloudflare. Remote result submission saves findings/drafts; production classification imports occur only when the operation was explicitly authorized to apply reviews. The existing five-field import envelope remains unchanged. Local JSON files described below are optional exports or explicit offline recovery artifacts.

## Review record

Write `reviews/<package>.json` with these fields. Copy identifiers from `evidence/<package>.json`, not from memory:

```json
{
  "package_name": "example",
  "evidence_hash": "exact Cloudflare hash; empty means unbound draft",
  "product_commit": "exact catalog source commit",
  "reviewed_by": "actual reviewing agent or maintainer",
  "decision": {
    "relationship": "direct",
    "capability_category": "store listing launcher",
    "rationale": "Concrete package-wide finding with scope and limitations.",
    "capabilities": [{
      "provider": "Play Store",
      "action": "openAppPage",
      "evidence": "Paraphrased documented API behavior and source section.",
      "source_url": "https://pub.dev/packages/example/versions/1.0.0",
      "deeplinkx_apis": ["PlayStore.openAppPage"],
      "migration": "partial",
      "caveats": ["Explain the parameter/runtime difference."]
    }],
    "providers": ["Play Store"],
    "actions": ["openAppPage"],
    "migration_status": "partial",
    "expansion": false,
    "review_status": "reviewed"
  },
  "review": {
    "reviewed_at": "UTC ISO timestamp",
    "fingerprint": "helper-generated semantic fingerprint",
    "finding": "What the previous classification got right/wrong, and corrected evidence.",
    "limitations": ["Documentation/source review only; no device execution."],
    "sources": [{"url": "https://pub.dev/packages/example/versions/1.0.0", "label": "Published README, usage section"}]
  }
}
```

Use actual provider names/API identifiers from `product-catalog.json`, including `verified_shared_apis` when the committed export chain was checked. For unsupported but established behavior use a descriptive action and an empty API list. `providers` and `actions` must equal the distinct values in `capabilities`. Inbound/adjacent findings may have no mapped APIs. Noise normally has no capabilities; its affirmative purpose evidence belongs in rationale/finding and sources.

Do not fabricate a hash for a package not enriched in production. A manually inspected unbound package can be a valid local review and ledger entry while its import file remains a draft. Unknown decisions remain drafts. `validate` emits only the existing five-field import envelope to `ready/` or `drafts/`; local provenance never silently extends the production API.

## Evidence and reuse

`evidence/<name>.json` retains normalized metadata, full stored documentation, metrics, original decision, database identifiers, timestamps, and discoveries. `sources[]` records extra resource URLs/hashes/kinds/origins and gap reasons. Keep raw source bodies under `sources/`, never in prompts.

The ledger records the last validated manual decision, fingerprint, scope, product commit, reviewer, original review time, sources, finding, and `skip_unchanged`. Noise adds `unrelated_functionality`. Unknown decisions use `wait_for_evidence`; they remain drafts. Metrics do not enter semantic fingerprints. Do not upgrade `screen_noise` to reviewed without actually inspecting its evidence.

Ledger entries also retain `behavior_evidence` (observed version, description, topics, repository, normalized documentation hash, and supplemental non-metric URL/hash map) and `evidence_path` to the supporting local packet. Relevant decisions carry `semantic_mapping_policy_version: external-app-mapping-v2`; noise does not depend on this version. Compare populated observations against prior evidence; absence or truncation is not a change. Legacy ledgers can use the recorded local evidence path; with only an opaque fingerprint, do not fetch missing evidence just to invalidate a noise decision. Only an already-observed material external-app capability/purpose contradiction reopens confirmed noise. Version numbers and evidence hash changes alone do not.

Confirmed noise requires same scope, `relationship: noise`, `review_status: reviewed`, and a semantic decision origin rather than screening. `reuse-summary.json` retains skipped decisions and original provenance before collection/enrichment. D1 collection excludes reusable names before selecting full resources; public collection avoids its noise endpoint and filters incidentally returned rows locally. Already-observed material contradictions take precedence over a name-only exclusion; version-only changes do not. A fresh run does not fetch noise to discover whether it changed. An explicit override must be passed at the stages being rerun; frozen selections are not silently recollected.

The `packets` command regenerates five-package compact packets, omitting confirmed noise unless controls are explicitly enabled. Use a fresh ledger to measure how many semantic reviews can be skipped on the next identical snapshot. A reuse result is not a new LLM review.

## Markdown report notes

Before `render`, supply these short authored files:

- `report-notes.md`: audit status, timestamps, candidate-pool bounds, selection/substitutions, discovered/enriched/reviewed counts, evidence gaps, and no-production-write statement.
- `improvements.md`: prioritized classifier/enrichment/review-script recommendations with observed examples and positive/negative regression cases.
- `opportunities.md`: at most five sourced opportunities with package metrics, existing support, missing capabilities, and caveats.
- `usage.md`: snapshot-bounded input/cached/output tokens where available, tool/skill invocation counts, Cloudflare and upstream requests, packet characters, cache/reuse results. Exact source-specific billed tokens are generally unavailable; mark approximations and account-wide quota changes honestly.

`render` generates every selected package row and individual finding from validated records. There is no operation-wide package-count ceiling; each semantic packet contains at most five packages. Preserve metric observation dates and unavailable values. `ready` is snapshot-relative: use a server-side hash/product check during an authorized import. Screened and evidence-gap records always remain drafts and never enter the persistent semantic-decision ledger. Do not import as part of this skill unless the user separately requests that action.
