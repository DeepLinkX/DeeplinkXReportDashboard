# DeeplinkX Report Dashboard Guidelines

These instructions apply to the entire standalone report-dashboard repository.

- Treat `https://deeplinkx-visibility.parham-dev.workers.dev` and its D1 database as the canonical permanent report history.
- Preserve the existing Worker name, D1 database, queues, schedules, public API payloads, and public URL unless a request explicitly changes them.
- Never commit `.dev.vars`, credentials, D1 exports, raw pub.dev responses, checkpoints, diagnostics, migration output, builds, caches, or dated generated reports.
- Never automatically delete public reports, normalized ranks, charts, comparisons, package statistics, recommendations, exports, or migrated legacy documents.
- Generate catalogs only from an explicit committed DeeplinkX product checkout. Keep compact schema-v3 query IDs, definition hashes, compatible depths, and honest `LOST` semantics stable.
- Keep pulse/top-10 and full/top-100 histories separate. Never describe pub.dev rank or competitor recurrence as search volume, traffic, popularity, conversion, revenue, market share, or demand.
- Audit scans must fetch fresh pub.dev results, run sequentially, checkpoint every page, honor `Retry-After`, and keep incomplete failures distinct from absence.
- Store secrets with Wrangler and use constant-time authorization checks. Keep public cache keys canonical and protected/static/scan traffic outside Workers Caching.
- Update `README.md` whenever URLs, schedules, schema, catalog inputs, commands, retention, backup, cache, or recovery behavior changes.
- Use Node.js 22.12 or newer. Run generated types, type checking, tests, production build, Wrangler dry run, and `git diff --check` before deployment.
- Do not start an audit during a code-only deployment unless explicitly requested.
- Do not commit unless explicitly requested.

Quality footer for main assistant responses:

- Alternatives:
- Verification:
- Assessment:
- Commit Message:
- Confidence:
