---
name: review-deeplinkx-competitors
description: Review discovered pub.dev packages against DeeplinkX capabilities using Cloudflare-owned evidence, decisions, and progress. Reuse completed reviews, exclude confirmed noise, examine changed claims, and produce an evidence-backed competitor report. Use for competitor examination, not search audits or product implementation.
---

# Review DeeplinkX competitors

Use the existing Cloudflare Worker as the evidence store, review ledger, collector, and report renderer. The model answers unfinished semantic questions; deterministic processing runs in the Worker. Do not load the complete registry into a prompt or require a local snapshot to resume.

## Start or resume

Read the dashboard's `AGENTS.md` and [Cloudflare workflow](references/cloudflare-workflow.md) once. Use `scripts/review.py remote --help`. Locate the existing operation ID before starting another operation. The operation records the committed product inventory; reuse it rather than checking product APIs again per package. Import eligibility is checked server-side against the supporting evidence and product commit.

Start with a stable idempotency key. Default mode is Cloudflare-first, with applying classifications disabled. A normal review may save operation progress and draft answers. Applying classifications, migrations, deployment, or schedule changes requires authorization from the current user/task; the skill itself grants none. Carry existing authorization forward without asking again.

## Choose the inexpensive lane first

- **Confirmed noise:** retain identity and exclusion provenance only. No metadata/version polling, README, changelog, scores, automatic sampling, or model packets. Existing metrics are preserved but irrelevant to routine review. Version-only, metric, product, classifier, and timestamp changes do not reopen noise. Reopen only for already-observed material behavior/scope changes or an explicit request.
- **Reviewed and unchanged:** reuse the decision, evidence, comparisons, and original reviewer/time. Reuse is not a new manual review.
- **Relevant observed update:** examine changelog additions since the reviewed baseline. Do not inspect every intermediate version or reread unchanged capabilities. Expand documentation only to answer a relevant new claim.
- **Unfinished mapping/conflict:** inspect the named claim or conflicting section, not the entire package again.
- **Previously examined unknown with unchanged evidence:** preserve its concrete evidence gap without another model pass.
- **New candidate:** screen its cached purpose before collecting details. Script screening remains provisional; mixed functionality must not be discarded as noise.

## Examine compact packets

Claim at most five packages. Share the product inventory once per reviewer; subsequent packets reference its ID/commit. There is no forty-package operation ceiling. Use disjoint leases for parallel review; never duplicate another reviewer's assignment.

Read [the rubric](references/review-rubric.md) once when semantic review is needed. Require a package-owned action, destination, parameters/platform, source locator, and a verified DeeplinkX execution path. Distinguish text/files, inbound/outbound, embedded/external navigation, URL construction/launching, and server/client APIs. Expansion is independent of relationship.

Initial excerpts are capped at 4,000 characters per package. Request additional stored sections only for a named unanswered question. A truncated excerpt is not missing documentation. Only the Worker contacts upstream sources; record the missing fact and why full stored evidence cannot answer it. `--cloudflare-only` forbids upstream requests.

## Save and finish

Use [record contract](references/record-contract.md) when writing answers. Submit structured findings, sources, caveats, and the existing five-field envelope when evidence-bound. Never invent a hash. Unknown/conflicting results remain drafts. Stored metric dates remain intact; missing fields are unavailable values, not zeros or repeated fetch targets.

Render reports through the Worker. Do not regenerate tables in prose, repeat completed checks, or poll with an LLM while collection waits. Report semantic reviews, reused decisions, script screens, exclusions, and gaps separately. Record measurable requests/packet sizes and available token/cache counters; do not invent per-tool billing or savings.

Local files are optional exports. Use the offline-recovery section of the workflow reference only when explicitly requested. Never claim older-model validation or device behavior that was not tested.
