# Capability and evidence rubric

## Relationship and opportunity are different dimensions

| Relationship | Required basis |
|---|---|
| direct | At least one documented external-app action maps to a verified DeeplinkX public API; partial overlap is enough, full replacement is not implied. |
| adjacent | Linking/availability infrastructure, inbound routing, generic runtime infrastructure, or unsupported external-app functionality without established supported-action overlap. |
| noise | Affirmative evidence establishes unrelated functionality in the reviewed scope. Do not infer noise merely from a failed fetch or absent keywords. |
| unknown | The available evidence cannot reliably decide the relationship. Keep missing enrichment separate from semantic ambiguity. |

`expansion` is independent: direct and adjacent packages can both reveal missing external-app capabilities. Do not label generic internal routing, UI, auth, or arbitrary services as expansion merely because DeeplinkX does not implement them.

## Evidence procedure

For each material claim identify **actor → operation → destination/object → result**. Confirm the package, not a dependency, setup instruction, sponsor app, or README example's surrounding application, provides the behavior. Preserve a section or code-symbol locator. Prefer a paraphrase with a source link; do not reproduce large README passages.

Evidence strength: public API/source at the published version → executable usage example → precise README claim → precise metadata → package name/query appearance. The last two alone cannot prove migration compatibility. Search results establish discovery, not functionality. A README claim can establish documented overlap but is not device-tested behavior.

Versioned pub.dev URLs are preferable to moving latest pages. Repository links must identify a tag/commit for implementation claims. Each supplemental source records URL, content hash, observed time, origin, and question answered. Keep uncertainty when a document is incomplete or contradicted.

Review selected source files and inherited APIs at the product's committed checkout. Distinguish:

- app/store opening versus a particular profile, message, review form, or listing;
- profile by username versus phone number;
- text or URL sharing versus native files, media, stories, reels, or stickers;
- directions by address versus coordinates, origin, travel mode, and waypoints;
- raw URL construction versus launching, installed checks, and fallback;
- standalone Dart use versus Flutter dependency and platform implementation;
- API documentation/platform tags versus action-specific platform behavior.

Migration status per capability: `supported` only when required behavior/parameters/runtime are established; `partial` for real overlap with differences; `unsupported` for an established capability without a mapped API; `needs_review` for unresolved evidence. Overall `partial` is appropriate when a package mixes supported overlap and gaps. Avoid claiming total replacement from one matched action.

## Specific failure patterns

| Case | Correct review behavior |
|---|---|
| `flutter_facebook_app_links`: opening `info.plist` | Setup file operation, not `Facebook.open`; actual receiving of deferred links is adjacent inbound infrastructure. |
| `typed_deep_links`: packages share one lockfile | Build/workspace sharing, not text sharing; inspect typed parsing/building of internal routes separately. |
| `draggable_menu`: familiar Instagram-like UI | UI inspiration does not establish opening Instagram. With confirmed UI-only purpose, use noise/unrelated_functionality/skip_unchanged. |
| `telegram`: Bot API plus URL schemes | Mixed package: do not let a backend exclusion erase real outbound capabilities; review both branches. |
| `open_store`: GooglePlay/AppStore spellings | Normalize provider aliases using API parameter context, then distinguish store listing actions from root store opening. |
| map/service packages | Generating route coordinates or embedding a map widget differs from launching a map application. |
| `whatsapp_unilink` | Outbound WhatsApp URL builder, not inbound routing. Compare Flutter chat/text use separately from standalone Dart and phone sanitization. Sanitization does not imply local-to-international country-code conversion. |
| general launcher with one Instagram example | Keep generic functionality and demonstrated provider overlap distinct; do not claim Instagram is its exclusive scope. |

## Reusable noise and change handling

Confirmed noise uses `noise_reason: unrelated_functionality` and `review_policy: skip_unchanged`. This describes the review scope, not quality. Never keep a permanent name blacklist.

Fingerprint meaningful behavior documentation and supplemental behavior sources; keep observed version separate from behavior identity; exclude metrics, observation timestamps, ranks, and automatic classifier version from semantic identity. Reuse only the same scope. When behavior changes, review the changed claims. A new product commit requires migration reassessment for relevant packages but need not invalidate UI-only noise if scope is unchanged. When an import hash changes for bookkeeping reasons, rebind only after checking the semantic evidence; never copy an obsolete import hash.

Script screening is provisional and must have its own origin. Contradictory/mixed evidence routes to review. Routine controls default to zero. Explicit sampling may inspect possible false negatives, but confirmed noise never fills mandatory pilot slots. Only already-observed material behavioral/scope changes or explicit overrides reopen reviewed noise; version-only changes do not; missing evidence, metric refreshes, product commits, classifier changes, and mapping-policy changes alone do not. Record which packages were reused, screened, or individually reviewed; avoid counting all discovered records as inspected.

## Prioritize improvements from actual failures

For each recommendation provide: example package + incorrect claim + source locator + cause in current logic + proposed behavioral change + positive and negative regression cases + operational/token benefit + limitation. Separate candidate enrichment defects from classification defects. Do not recommend broader fetching when existing Cloudflare evidence answers the question.

Evaluate rules against a reviewed fixture set and report sample disagreements. Do not automatically deploy recommendations. Preserve permanent observations and exports; future corrections concern derived classifications and comparisons.
