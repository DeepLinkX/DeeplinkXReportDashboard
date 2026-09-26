# DeeplinkX Report Dashboard

The canonical DeeplinkX pub.dev visibility history is the public, read-only dashboard:

- Dashboard: <https://deeplinkx-visibility.parham-dev.workers.dev>
- DeeplinkX live demo: <https://deeplinkx.github.io/DeeplinkX/>
- Dashboard source: <https://github.com/DeepLinkX/DeeplinkXReportDashboard>
- Product source: <https://github.com/DeepLinkX/DeeplinkX>

The dashboard measures where `deeplink_x` appears in bounded pub.dev result sets. It is a marketing-maintenance tool for the package owner, not user-installable automation. Visitors can view reports, trends, comparisons, competitors, matrices, legacy sources, and Markdown/CSV/JSON exports without authentication. Administrative actions remain private.

This is a standalone maintainer project. It owns the Worker, dashboard, schema-v3 catalog, D1 migrations, reporting logic, and operational documentation. The DeeplinkX package repository supplies product evidence only and contains no report/dashboard implementation. Keep this guide current whenever the public URL, schedules, schema, commands, storage policy, or maintenance workflow changes.

## Audit profiles

| Profile | Schedule (UTC) | Depth | Selection | Purpose |
| --- | --- | ---: | --- | --- |
| `pulse` | Monday at 06:00 | Top 10 (one page) | Fixed 48 compact terms, 10 structured expressions, and the four-query matrix for six hero apps plus newly added providers | Fast weekly release visibility pulse |
| `full` | First day of each month at 00:00 | Top 100 (up to ten pages or result exhaustion) | Complete app, store, action, and navigation catalog | Broad monthly portfolio audit |

A scheduled pulse is skipped when a full audit is active or already completed on the same UTC date. Cron only creates an idempotent run and enqueues work. A single Queue consumer scans one query at a time, checkpoints every page, honors `Retry-After`, and retries transient failures with bounded exponential backoff and jitter. Permanently failed search messages go to the dead-letter queue and make the run incomplete; they are never converted into false “not found” results.

After a full scan completes, the same Queue enriches every raw competitor candidate one package at a time from pub.dev metadata and bounded published README evidence. Dispatches use resumable batches of 100; candidates are not excluded by a global frequency cutoff. The raw report and its immutable exports materialize without waiting for this derived work. A permanent metadata failure leaves that package classified as `unknown` and marks competitor classification partial; pending or failed classification never turns a complete search scan into an incomplete one.

Every weekly snapshot captures the published version and date, description, topics, pub points, likes, 30-day downloads, rendered package page, and rendered score page. Local and published metadata are kept separate so an unpublished checkout is never described as live.

## Schema-v3 catalog

The checked-in catalog is [catalog-v3.json](catalog/catalog-v3.json). Its generator and validator live in this repository alongside the Worker, D1 migrations, dashboard, tests, and migration tooling.

Each query has a stable `query_id`, compact query text, lane, product area, expression type, profiles, product fit, source evidence, definition hash inputs, and catalog version. The catalog includes:

- 48 fixed compact raw terms, including `deeplink`, `deep link`, map launching, store redirects/fallbacks, installation checks, and package alternatives;
- 10 documented `sdk:flutter` and `topic:` expressions;
- four compact terms for every supported app;
- store launcher/redirect terms;
- navigation-provider terms only for documented capabilities;
- existing compact action phrases plus short and verb-based variants for every public app/store action, including `WhatsApp share`, `Telegram profile`, `Telegram open profile`, and `Play Store open app page`.

Pub.dev-channel queries intentionally exclude sentence templates, “how to” searches, Medium titles, and Stack Overflow questions. Those belong to a separate source-backed content-discovery dataset and are not scanned as pub.dev keywords. Duplicate normalized terms share one stable definition rather than expanding across multiple stages.

The Worker refreshes the catalog from the repository default branch before scheduled runs, validates schema, hash, and budgets, and retains the last valid catalog if synchronization fails. It refuses catalogs above 120 pulse or 1,500 full queries before creating a partial run.

Generate a catalog from an explicit, committed DeeplinkX checkout. The generator rejects dirty `pubspec.yaml`, `README.md`, `doc/apps/`, or `lib/src/apps/` evidence so `source_commit` remains reproducible:

```bash
npm run catalog -- --source-repo ../deeplink_x
```

Existing fixed-catalog evidence locations are stable schema-v3 provenance identifiers. They intentionally retain their original value after this repository extraction so moving source code does not redefine historical query hashes. The catalog's top-level `source_url` points to the immutable DeeplinkX product commit used for generation.

## What the numbers mean

Rank is bounded visibility inside one completed pub.dev scan. It is not search volume, traffic, popularity, conversion, revenue, market share, or business demand. Raw competitor frequency is recurrence across this explicit query catalog, not popularity.

Competitor relationships use a versioned deterministic classifier over each package's published name, description, topics, and bounded published README evidence:

- `direct`: evidence establishes overlapping external/provider/map actions, outbound link construction, application-store launching, or fallback behavior;
- `adjacent`: general URL launching, explicit inbound/dynamic-link handling, system sharing, expansion-only actions, or standalone application-availability checks; universal-link terminology alone does not establish inbound behavior;
- `noise`: published metadata establishes unrelated icon, font, UI, theme, or similar functionality;
- `unknown`: metadata is missing or does not establish a relationship; the service never guesses that it is a competitor.

The classifier version is stored per package and run. A future version bump resets only stale candidate rows to planned state so the protected backfill can re-enrich them without touching raw search evidence.

The dashboard shows direct and adjacent packages separately and collapses noise/unknown rows by default. Relevant appearances, best rank, and median rank use only query families compatible with the classified capability. The original raw occurrence, best-rank, median-rank, and dominant-query category remain available as unchanged audit evidence.

Classification is an additive mutable view. It does not change or regenerate the raw competitor sections already stored in immutable Markdown, CSV, or JSON report exports.

Pulse and full series remain separate. Comparisons require the same profile and effective depth and operate only on unchanged stable query IDs. Added, retired, and redefined queries are catalog changes, not rank movement. `LOST` is reported only when the later completed scan reached sufficient depth, or exhausted its results, to establish the absence. A shallower observation cannot establish a loss.

## Historical analytics

The dashboard's [History page](https://deeplinkx-visibility.parham-dev.workers.dev/history?profile=pulse&range=all) is the canonical view of changes over time. It defaults to the weekly `pulse` profile and all available history. The selected profile and range stay in the URL so a filtered view can be shared directly.

Available ranges are rolling 30 days, rolling 90 days, one year, all history, and an inclusive custom UTC start/end range. Rolling presets are calculated from the latest available package snapshot rather than the viewer's local date. Pulse/top-10 and full/top-100 histories are never mixed.

The page provides two complementary views:

- net movement compares the first and last compatible reports in the selected range;
- the adjacent timeline shows every compatible dated transition, with release version and catalog-change annotations.

Movement terms have exact meanings:

- `improved`: the numeric rank became better; for example, `#7 → #2` gained five positions;
- `dropped`: the numeric rank became worse; for example, `#2 → #7` lost five positions;
- `found`: a previously unranked query entered the completed scan depth;
- `lost visibility`: a previously ranked query disappeared and the later completed depth or result exhaustion proves the absence;
- `withheld`: the observations cannot establish a comparable result, including an incomplete query or a later scan too shallow to prove disappearance;
- `unchanged` and `not visible`: the stable query stayed at the same numeric rank or remained absent at both compatible endpoints.

Incomplete runs and July 1's `legacy-mixed` observations remain visible in the archive but are excluded from rank movement. When more than one complete report exists for one UTC date, the dashboard selects one canonical observation and prefers live/non-migration evidence over a migrated duplicate. Added, retired, and definition-changed queries remain catalog events rather than rank movement.

Package metrics are independent of the selected rank profile and are canonicalized to one observation per UTC date. Rolling 30-day downloads, likes, and pub points use separate scales and separate charts. Missing observations remain visible gaps; the dashboard never interpolates them. “Rolling 30-day downloads” is the pub.dev snapshot label and is not cumulative downloads, traffic, conversions, or demand.

Public historical interfaces use five-minute Workers Cache entries and tag-based invalidation whenever a report is materialized:

- `GET /api/v1/history/summary?profile=pulse|full&from=YYYY-MM-DD&to=YYYY-MM-DD` returns first-to-last movement, query-level results, catalog changes, adjacent transition summaries, and excluded-run reasons;
- `GET /api/v1/history/events` returns cursor-paginated adjacent-snapshot events and accepts an outcome filter and a maximum page size of 250;
- `GET /api/v1/stats?canonical=1&from=YYYY-MM-DD&to=YYYY-MM-DD` returns one package snapshot per UTC date, preferring non-migration evidence.
- `GET /api/v1/runs/:runId/competitors?relationship=direct,adjacent` returns additive metadata classification, relevant metrics, raw metrics, and classification completeness. Omit the filter or use `all` to preserve the complete bounded candidate response.

## Public API caching

The Worker uses a cache-enabled `PublicAPI` entrypoint behind an uncached gateway. Only canonical public `GET` requests enter that cache. Static Assets, health checks, protected maintainer endpoints, errors, Cron, Queue processing, and outbound pub.dev scans bypass it. New audits always fetch fresh pub.dev pages; successful page checkpoints are resume state, not cross-audit cache entries.

Cache keys contain only validated parameters that affect a response, in a fixed order. Ignored parameters, caller cookies, and authorization headers never create public variants. Profile, date range, outcome, cursor, lane, provider, product area, competitor relationship, run ID, and query ID values remain distinct where they change results.

| Response class | Examples | Browser policy | Edge policy |
| --- | --- | --- | --- |
| Live | Overview summary, run list, active run detail/results | 30 seconds | 30 seconds |
| Mutable history and derived views | Package statistics, history summary/events, query history, competitor classification, legacy index | 60 seconds | 5 minutes plus 60-second stale-while-revalidate |
| Immutable | Materialized run data, recommendations, compatible comparisons, legacy documents, exports | One year, immutable | One year, immutable |
| Uncached | Health, admin, non-GET, incomplete/error responses | `no-store` | `no-store` |

Mutable responses carry the `visibility:mutable` cache tag. Active run responses also carry a run-specific tag. Run creation, finalization, dead-letter transitions, catalog activation, legacy import, and retention-state changes purge the affected tags through the `PublicAPI` entrypoint. A purge failure is written to private diagnostics and never rolls back durable report data; the bounded TTL remains the fallback. Cross-version caching is disabled, so every deployment starts with a cold API cache.

To inspect caching without credentials or starting an audit, request the same canonical endpoint twice and inspect `Cf-Cache-Status`:

```bash
curl -sS -D - -o /dev/null \
  'https://deeplinkx-visibility.parham-dev.workers.dev/api/v1/history/summary?profile=pulse'
```

The first request after deployment, expiry, or purge is normally `MISS`; a repeated request is `HIT`. `BYPASS` is expected for health, protected APIs, and `no-store` responses. When investigating stale data, first compare the browser `Cache-Control` and edge `Cloudflare-CDN-Cache-Control` headers, then check private diagnostics for `cache-purge-failed`. Never purge permanent D1 history to correct an edge-cache issue.

Recommendations are deterministic evidence classes:

- `protect`: a high-fit query ranks in the top three;
- `metadata gap`: a relevant phrase is absent from the published name, description, and topics;
- `authority gap`: published metadata contains the phrase, but other results outrank DeeplinkX or DeeplinkX is absent at the completed depth;
- `capability gap`: repository-supported behavior lacks corresponding package-landing wording;
- `noise`: a broad or lower-fit query is dominated by unrelated package categories.

## Permanent history and retention

Public history is permanent. The service never automatically deletes visible reports, normalized ranks, charts, compatible comparisons, package statistics, aggregates, recommendations, exports, or migrated legacy sources.

Only internal, reproducible inputs expire:

- routine raw HTTP bodies: 90 days;
- completed checkpoints and diagnostics: 30 days;
- abandoned working data: 90 days;
- legacy source documents: permanent.

Reports and exports must be materialized and verified before their raw inputs are eligible for pruning. Storage safeguards use the configured D1 capacity:

- at 70%, prune expired internal artifacts;
- at 85%, stop retaining new raw bodies and record a private warning;
- at 90%, pause full audits and record a private warning;
- never prune public history automatically.

## Maintainer operations

Run commands from this repository root. Use the authenticated Cloudflare account that owns `deeplinkx-visibility`, its D1 database, and the scan/dead-letter queues.

### Install, verify, migrate, and deploy

```bash
npm ci
npm run types
npm run typecheck
npm test
npm run build
npm run db:migrate:remote
npm run deploy
```

`npm run build` performs a Vite production build and Wrangler dry run. The Worker deploy includes Static Assets, public/private APIs, Queue handlers, and the two Cron triggers. Do not enable or change schedules until production migration and a manual pulse reconcile successfully.

### Restore and move a D1 snapshot without a second full export

For the September 22 recovery snapshot, use the existing external `pre-policy-backup.sql`; do not make another full export just to replay it. Keep the backup, migrated SQLite file, manifests, chunks, progress files, and temporary credentials outside this repository. `scripts/prepare-d1-backup.py prepare` imports the SQL locally, applies migrations absent from that snapshot, chunks oversized immutable report artifacts while preserving their original hashes, and checks SQLite and foreign-key integrity. `verify` repeats the integrity and artifact-hash checks. `chunks` creates deterministic, individually hashed batches for a fresh D1. It refuses output inside a Git checkout and never replaces an existing database or non-empty chunk directory.

Run `python3 scripts/test_prepare_d1_backup.py` to exercise UTF-8 splitting, foreign-key ordering, deterministic chunk hashes, artifact integrity detection, and repository-path protection before preparing a snapshot.

The temporary protected importer writes only to the explicitly configured staging D1. It accepts an allowlist of tables, validates each payload hash, writes a receipt in the same D1 batch as its rows, and makes uncertain-response retries idempotent. Resume with the same manifest and progress file; the importer checks its receipt if a response was saved before the local checkpoint. The default daily budget is 20,000 D1 rows written, leaving room for the live dashboard on the account's Free plan. D1 quotas are account-wide: creating another database does not reset daily read/write quotas. A quota response stores a `resume_after` checkpoint; rerun only after that UTC reset. Do not exceed the account's remaining write budget while scheduled dashboard processing is active.

Do not change the production Worker binding until the staging database passes row-count reconciliation, SQLite-to-D1 artifact hash checks, migration checks, and API smoke tests. During cutover, update only the D1 binding and retain the Worker, database history, queues, schedule, public URL, and cron expressions. Keep the previous D1 available for rollback until the new binding passes production health and report-history checks. Never import operational receipt rows from the source snapshot; they are generated for the destination's resumable import.

Reports larger than 1.5 MB are stored as ordered 256 KB UTF-8 chunks. API exports reconstruct the original content and verify its stored SHA-256 before returning it, so public filenames, content types, and immutable hashes remain stable. The 2 MB D1 value limit applies to individual values; chunking allows the existing larger report exports to remain available.

The review skill can use the same frozen snapshot in read-only mode with `review.py collect --sqlite-db ...` and `review.py prepare --sqlite-db ...`. This mode makes no Cloudflare or pub.dev requests and must label the September 22 evidence as a frozen snapshot, not current live data.

For a competitor-classification release, create and verify an external D1 backup first, apply pending migrations, and deploy. Start audits only when explicitly requested. When both profiles are requested for one UTC date, complete the pulse first: an active/completed full run makes a later pulse skip. Then enqueue the idempotent derived-data backfill; this does not rescan historical pub.dev results or rewrite immutable exports:

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer ${DEEPLINKX_VISIBILITY_ADMIN_TOKEN}" \
  -H "Idempotency-Key: competitor-backfill-YYYY-MM-DD" \
  -H "Content-Type: application/json" \
  --data '{}' \
  https://deeplinkx-visibility.parham-dev.workers.dev/api/v1/admin/competitors/backfill
```

Pass `{"run_id":"RUN_ID"}` only to resume or verify one materialized full report. Reusing an idempotency key returns the original bounded result. Backfill operates only on preserved `search_positions`; reports without non-DeeplinkX positions are returned under `unavailable_runs`.

Regenerate the checked-in catalog after provider, action, store, documentation, or package metadata changes, then review its source commit, hash, profile counts, and evidence before deployment:

```bash
npm run catalog -- --source-repo ../deeplink_x
npm test
```

Historical migration is intentionally explicit and writes outside this repository:

```bash
npm run migrate:legacy -- \
  --source-dir /absolute/path/to/historical-markdown \
  --output-dir /absolute/path/outside/repositories/deeplinkx-migration
```

### Secret handling

Set or rotate the Worker secret interactively; never place it in `wrangler.jsonc`, `.dev.vars`, shell history, browser code, documentation, or a URL:

```bash
npx wrangler secret put ADMIN_TOKEN
```

Maintainer commands read the token from `DEEPLINKX_VISIBILITY_ADMIN_TOKEN`. On this maintainer machine it may be loaded from macOS Keychain without printing it:

```bash
export DEEPLINKX_VISIBILITY_ADMIN_TOKEN="$(security find-generic-password \
  -a parhamhatanian \
  -s deeplinkx-visibility-admin-token \
  -w)"
```

Unset it after maintenance:

```bash
unset DEEPLINKX_VISIBILITY_ADMIN_TOKEN
```

### Personal-skill commands

The personal skill remains private at `~/.codex/skills/audit-deeplinkx-keywords/` and is not part of this public repository. It preserves local `discover`, `scan`, `report`, and `run` commands for temporary, checkpointed audits. Its Cloudflare helpers are:

```bash
python3 ~/.codex/skills/audit-deeplinkx-keywords/scripts/keyword_audit.py cloudflare-status

python3 ~/.codex/skills/audit-deeplinkx-keywords/scripts/keyword_audit.py \
  cloudflare-catalog-sync \
  --idempotency-key catalog-sync-YYYY-MM-DD

python3 ~/.codex/skills/audit-deeplinkx-keywords/scripts/keyword_audit.py \
  cloudflare-trigger \
  --profile pulse \
  --idempotency-key manual-pulse-YYYY-MM-DD

python3 ~/.codex/skills/audit-deeplinkx-keywords/scripts/keyword_audit.py \
  cloudflare-migrate \
  --payload /absolute/path/outside/repository/legacy-payload.json

python3 ~/.codex/skills/audit-deeplinkx-keywords/scripts/keyword_audit.py \
  cloudflare-export \
  --run-id RUN_ID \
  --format markdown \
  --output /absolute/path/outside/repository/report.md
```

Protected commands require the token environment variable. Status and export retrieval are public. Every mutation requires a bounded idempotency key; never reuse a key for different work.

Use `cloudflare-catalog-sync --bundled` only to activate an explicitly reviewed catalog packaged in a new Worker deployment before that same catalog reaches the repository default branch. Normal and scheduled synchronization must use the default branch; on failure the service retains its last valid active catalog and shows a freshness warning.

### D1 backup

Create backups outside the repository and verify that the output exists and is non-empty:

```bash
npx wrangler d1 export deeplinkx-visibility \
  --remote \
  --output /absolute/path/outside/repository/deeplinkx-visibility-YYYY-MM-DD.sql
```

Keep dated backups outside the Dart package and worktree. Do not copy live D1 files or commit exports.

### Competitor review reconciliation

The local `review-deeplinkx-competitors` skill writes frozen decisions and evidence outside both repositories. Reconcile those records through `scripts/reconcile-competitor-reviews.py`, which reads Cloudflare first, validates the exact deployed product commit, and keeps a response cache and phase checkpoint outside Git. Example:

```bash
python3 scripts/reconcile-competitor-reviews.py preview \
  --manifest /absolute/path/outside/repository/manifest.json \
  --output /absolute/path/outside/repository/reconciliation \
  --secrets-file .dev.vars
python3 scripts/reconcile-competitor-reviews.py sync --manifest /absolute/path/outside/repository/manifest.json --output /absolute/path/outside/repository/reconciliation --secrets-file .dev.vars --apply
python3 scripts/reconcile-competitor-reviews.py import --manifest /absolute/path/outside/repository/manifest.json --output /absolute/path/outside/repository/reconciliation --secrets-file .dev.vars --limit 10 --apply
python3 scripts/reconcile-competitor-reviews.py metrics --manifest /absolute/path/outside/repository/manifest.json --output /absolute/path/outside/repository/reconciliation --cloudflare-only
python3 scripts/reconcile-competitor-reviews.py report --manifest /absolute/path/outside/repository/manifest.json --output /absolute/path/outside/repository/reconciliation
```

Preview is read-only; sync and import default to dry-run and require `--apply` for mutations. Use `--packages` or `--limit` for bounded batches. Metrics prefer timestamped Cloudflare observations, then matching frozen local observations, then a sequential two-second-spaced pub.dev score request. `--cloudflare-only` leaves missing values explicit. Confirmed noise is omitted from metric collection. The helper checkpoints each resource response before phase aggregation, refuses redirects and untrusted URLs, records rate-limit cooldowns, and stops the phase on D1 quota exhaustion. Resume after the recorded deadline; reuse the same output directory only while the frozen manifest and evidence hashes remain unchanged.

### Daily quota recovery

The 1,500-query ceiling is a coverage bound, not a guarantee that a full audit and competitor enrichment fit in a free D1 day. D1 Free currently allows 100,000 rows written and 5 million rows read per account per UTC day; indexes also contribute writes. Scans, checkpoints, registry discovery, metrics, and classification share that allowance. A large run can span multiple daily resets. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) for current limits and paid-plan terms.

When D1 reports a daily read/write quota error, the consumer reschedules the original message before acknowledging it, without consuming its retry allowance. It waits until 00:01 UTC after the next reset, in chunks of at most 12 hours (the Queue delay limit). Existing run dates, query progress, and public history stay intact; quota diagnostics go to Worker logs because D1 cannot accept them. Affected API requests return `503`, `Retry-After`, and `Cache-Control: no-store`. Successful read-only endpoints may remain available during a write-only limit. Quota waits are not completed scans or evidence of package absence.

During snapshot recovery, `D1_WRITES_PAUSED=true` blocks all mutating HTTP methods and reschedules both scan and dead-letter Queue messages without touching D1. Cron schedules and the public read surface remain available; scheduled work stays queued until the pause flag is removed after cutover. Remove the flag only after the replacement database is validated and bound to the Worker.

Inspect Worker logs for `d1-daily-quota-deferred`, verify that the original run resumes after reset, and let its enrichment finish before assessing completeness. Never delete history or invent a new run date to bypass quota or daily report conflicts. A paid-plan change requires separate billing authorization; deployment does not authorize it.

For quota attribution, start with `npx wrangler d1 info deeplinkx-visibility` and `npx wrangler d1 insights deeplinkx-visibility --time-period 1d --sort-by reads --sort-type sum --sort-direction DESC --limit 20 --json`. The insights endpoint reports query patterns and aggregate rows scanned without issuing SQL against D1. Follow the largest repeated scans before retrying migration or report work. In particular, avoid running a full-table status aggregate once per package job; use an indexed pending-row existence check when the caller only needs readiness.

### Automatic startup recovery

Weekly and monthly cron events first enqueue a `start-operation` intent containing the original scheduled time, profile and idempotency key, before catalog synchronization or any D1 access. The same queue then initializes the report. Manual report, competitor refresh and backfill requests retain their normal successful response fields; if D1 quota or a temporary upstream/dispatch delay interrupts startup, they return `202` only after the original intent is accepted by Queue. The additive deferred response contains `operation_id`, `status: "deferred"`, `resume_after`, `status_url`, and `dashboard_url`. Queue rejection returns a retryable `503`; retry with the same idempotency key. Authentication and scope validation happen before accepting manual work.

`GET /api/v1/operations/:operation_id` and `/operations/:operation_id` show a sanitized startup status without exposing request keys, payloads or internal errors. Status responses use `Cache-Control: no-store` and bypass Workers Caching. If quota prevented the first D1 write, the operation endpoint honestly returns `404` until its first database checkpoint exists; a missing status record alone does not establish absence from Queue. Keep the accepted response and operation ID. The dashboard does not poll continuously. `started` means initialization finished, not that the report or competitor enrichment is complete; follow the report link for progress.

Startup records and report-initialization cursors use namespaced `startup:` and `run-init:` entries in the existing `system_state` table. They are retained for idempotency and recovery, included in storage estimates, and require no schema migration. Initialization fills only missing query rows, reuses the run's selected catalog and successful package-snapshot resources, and checkpoints each dispatch batch. Replayed deliveries skip completed evidence. Original requested dates and existing profile/date conflict rules remain authoritative across resets; catalog selection is recorded when creation actually becomes possible. A startup that exhausts non-quota retries is recorded as failed for maintainer review.

No additional schedule, recurring LLM call, paid-plan change, or assistant automation is required for future queued report processing to resume. This is recovery for resettable D1 quotas and temporary upstream delays; capacity limits and permanent errors still need intervention. A Cloudflare Queue outage that prevents initial acceptance is reported explicitly rather than promising automatic recovery.

### Dead-letter and incomplete-run recovery

1. Inspect Worker logs and the private `diagnostic_events` rows without copying credentials or raw responses into an issue.
2. Confirm whether the dead letter represents a scan query, competitor metadata enrichment, or report finalization. Dead scan queries remain failed and the report remains incomplete. Dead competitor enrichment becomes an explicit `unknown` row and partial classification. A finalizer failure can be resumed after its cause is corrected.
3. Fix and deploy the underlying bounded failure, then call the protected maintenance endpoint to resume eligible finalizers:

   ```bash
   curl --fail-with-body \
     -X POST \
     -H "Authorization: Bearer ${DEEPLINKX_VISIBILITY_ADMIN_TOKEN}" \
     -H "Idempotency-Key: maintenance-YYYY-MM-DD" \
     https://deeplinkx-visibility.parham-dev.workers.dev/api/v1/admin/maintenance
   ```

4. If a scan query permanently failed, create a new manual run with a new idempotency key after the cause is fixed. Do not edit an immutable public report to pretend the failed observation completed.
5. Verify the replacement run, exports, and public dashboard before any manual cleanup. Never purge permanent report history.

The public summary exposes bounded storage status and catalog freshness. Private warnings and internal errors must not be returned through public endpoints.

## Historical migration

Six dated visibility reports and five comparison documents from July–August 2026 were imported with source hashes and provenance. July 1 retains row-level mixed depths; July 6, 10, and 19 are full/top-100; August 10 and 27 are pulse/top-10. `baseline-only` observations stay tied to their original snapshots, and unmatched sentence-style or retired terms remain in the legacy archive without entering future catalogs.

Dashboard comparisons are recomputed from normalized visibility snapshots; the original comparison Markdown is retained only as migration evidence. After production hashes, row counts, representative ranks, exports, compatible comparisons, and an external D1 backup were verified, the dated package-repository files were removed. The D1-backed dashboard remains the permanent public archive, and this README is the canonical operations guide.

Migrated July full reports preserve DeeplinkX ranks but not the other packages returned for each query. Their competitor classification is therefore shown as unavailable rather than reconstructed from current search results. Automated full reports with preserved package positions can be classified or backfilled without changing their immutable exports.


## Competitor directory and capability coverage

`/competitors` is a persistent directory independent of individual reports. The schema-v3 catalog now also carries a `capabilities` inventory: public API, app/store, source file, documentation, native platform declarations, action aliases, documentation warnings, and contributing query IDs. The current committed product baseline produces 166 actions and 642 full queries; pulse remains 82. These are snapshot counts, not hard-coded provider coverage rules.

The inventory reads public provider declarations from an explicit clean product checkout. Every public action must have a mapped vocabulary and at least one query. Unsupported/new actions fail generation. Documentation mismatches are recorded instead of inventing APIs. `Available Actions`, `Usage`, and `Basic Usage` sections contribute action wording; platform/configuration headings do not. Short and verb-based queries run in full/top-100; they do not inflate pulse/top-10. The 1,500 full limit is enforced in both catalog validation and Worker configuration.

The deterministic `capabilities-v2.4` classifier records multiple provider/action matches, source excerpts and URLs, migration caveats, and expansion flags. Automatic matches are provisional (`rule_matched`), not device-tested compatibility guarantees. Migration statuses are `supported`, `partial`, `unsupported`, and `needs_review`; automatic overlaps remain partial until reviewed. Plain-Dart URL construction, input normalization, platform-specific APIs, file/media sharing, and fallback behavior require distinct comparisons. The directory never infers unique users, conversions, or abandonment from downloads or release age.

### Metrics and interfaces

- `GET /api/v1/competitors` accepts `view=direct|adjacent|expansion|unresolved|noise|all`, `provider`, `action`, `platform`, `relationship`, `migration`, `review`, `age_months`, and `q`.
- `sort=downloads|likes|score|published|appearances|rank|name`, `order=asc|desc`, `page` (one-based), and `limit` (default 50, maximum 100) control database-side ordering/pagination. Filtering precedes pagination; missing sort values always come last; package name breaks ties. Defaults are direct competitors, downloads descending.
- `GET /api/v1/competitors/:package` includes comparisons, discovery evidence, and timestamped metric observations. Discovery details are bounded to 200 recent observations and metrics to 100 recent observations; permanent underlying history remains stored.
- Existing per-run competitor fields and immutable exports are preserved. The per-run competitor endpoint now returns the entire observed candidate set, with relationship filtering; the new directory is paginated.
- Downloads are pub.dev's rolling 30-day download count; likes and points/max points come from the score API. Publication date/version come from the package API. Missing metrics are null; failed refreshes retain previous observations and expose partial/stale status. Historical reports are never assigned newly captured metrics as if observed on their original date.

### Refresh, expansion discovery, and review

Complete full reports trigger registry import, all-candidate classification, and supplemental discovery. Complete pulse reports refresh the relevant directory plus selected review candidates. Eligible metadata and score resources are shared for seven days. Usable README evidence is reused for its recorded version regardless of age. Each successful resource is checkpointed before the next request; all outbound requests in the enrichment/discovery pipeline are sequential and honor `Retry-After`. Semantic evidence and scope changes reopen reviewed decisions. Product or mapping-policy changes invalidate affected relevant comparisons; they do not reopen unchanged confirmed noise.

Each pulse or explicit metrics refresh captures a score observation after its job was created, even when the previous score is less than seven days old. Retries reuse a successful observation from that same job; monthly discovery reuses fresh weekly metrics.

The scan and enrichment consumer spaces pub.dev requests by at least two seconds. HTTP 429 establishes a shared durable cooldown for all queued pub.dev work (at least 60 seconds, or the longer `Retry-After`). Waiting jobs are rescheduled without consuming their failure retry allowance, and saved page/resource checkpoints remain intact. Changed evidence and reviewed decisions also refresh derived per-run comparisons without rewriting immutable report exports.

`catalog/discovery.json` contains explicit package seeds and compact exploratory queries. It is separate from the supported-product rank catalog, capped at 200 supplemental queries and top 100 per query. Already completed matching full queries are reused for that monthly discovery; normal audit queries always fetch fresh results. Overflow is visible as deferred coverage. Package/query/page observations and manual seeds are retained, and jobs distinguish planned, queued, running, complete, and failed states.

No scheduled LLM requests occur. Maintainers can export up to ten selected packages with bounded evidence and import a reviewed decision tied to the exact `evidence_hash` and `product_commit`:

```bash
node --import tsx scripts/competitors.ts export whatsapp_unilink whatsapp_share > /tmp/competitor-review.json
node --import tsx scripts/competitors.ts import /tmp/reviewed-competitor.json
node --import tsx scripts/competitors.ts refresh
node --import tsx scripts/competitors.ts refresh --full
```

These commands read `DEEPLINKX_VISIBILITY_ADMIN_TOKEN` from the environment and use protected `/api/v1/admin/competitors/review/export`, `/review/import`, and `/refresh` endpoints. Review import expects `package_name`, `evidence_hash`, `product_commit`, `reviewed_by`, and a complete `decision` containing evidence-backed capabilities and migration caveats. Keep packets outside the repository. `refresh --full` explicitly requests supplemental searches; omit it for relevant-package metric refresh only.

Migration `0004_competitor_intelligence.sql` adds the registry, permanent metric observations/discoveries/reviews, and durable background jobs. Public evidence is permanent. Raw pub.dev bodies follow the existing 90-day internal retention policy; they are never committed. Storage estimates include the new tables, and batch dispatch checks storage safeguards.

Migration `0005_competitor_lookup_index.sql` indexes package/status lookups so shared evidence updates do not repeatedly scan the complete classification history.

After a deployment, synchronize the committed catalog from GitHub main and check its hash/counts before manual runs. Publish the reviewed catalog commit to main so a later scheduled sync cannot reactivate an older bundled catalog. Use unique idempotency keys for the weekly and monthly manual runs and wait for both report materialization and separate classification/job completion. For historical derived views, use the existing protected backfill without rewriting raw reports or exports.


### Confirmed-noise policy and reconciliation

Migration `0006_competitor_review_policy.sql` persists reviewed scope, semantic identity, provenance, reopening state, and processing outcomes. Only evidence-backed reviewed noise is a confirmed exclusion; automatic noise remains provisional. Confirmed noise receives no scheduled metadata, README, score, semantic review, or random sampling. Full/pulse admission, supplemental discovery, seeds, backfills, retries, and stale queued jobs apply the exclusion. Name-only discoveries remain recorded, and reusable decisions contribute to per-run classification totals. Existing metrics retain their timestamps; skipping collection is not a failure.

Observed package-version or semantic evidence changes, review-scope changes, or explicit maintainer reopening enter pending review. Downloads, likes, timestamps, repeated appearances, release age, seed membership, classifier versions, and product commits do not reopen confirmed noise. Ordinary refresh cannot bypass an exclusion. Non-noise direct/adjacent packages qualify for metrics; pulse additionally selects at most 100 unresolved candidates using capability evidence, uncertainty, recorded downloads (missing last), and name. Newly classified noise never requests scores. Reviewed decisions are resolved before metric eligibility.

Protected POST operations require bearer authorization and an `Idempotency-Key`:

- `/api/v1/admin/competitors/policy/preview`: `{ "packages": ["draggable_menu"] }`, at most ten unique package names; read-only evidence bindings and policy states.
- `/api/v1/admin/competitors/policy/reopen`: the same names plus a nonempty `reason`; changes eligibility without starting a search audit.
- `/api/v1/admin/competitors/evidence/sync`: at most ten `packages`, default `dry_run: true`. Each entry supplies package identity, expected current evidence hash (or null), product commit, normalized metadata, versioned documentation, observation date, and HTTPS source provenance with content hashes. Hashes are computed server-side; submitted URLs are never fetched. Conflicting versions, changed bindings, newer conflicting evidence, and attempts to erase stored documentation require reconciliation.
- `/api/v1/admin/competitors/refresh/packages`: up to ten package names, queued through the same exclusion policy; use for bounded verification without discovery searches.
- `/api/v1/admin/competitors/processing`: administrative counts for policy states, processing states, and job outcomes.

The existing five-field review-import contract remains unchanged. Reconcile evidence first, then import only decisions supporting the exact returned evidence hash and product commit. Unknown, stale, conflicting, and unbound decisions stay local drafts. Evidence synchronization alone does not approve a review. Public package details add processing status and policy state without removing existing fields.

Keep frozen snapshots, local review ledgers, reconciliation checkpoints, metrics, usage records, and reports outside both repositories. On quota exhaustion stop the current collection phase and resume from its checkpoint after reset; do not repeat the failing operation for every package. Back up D1 externally before applying migrations, verify the backup, then deploy the tested commit. Validate with a bounded representative refresh, not another full search audit. Immutable exports remain unchanged by evidence sync and review imports.
