import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import type { MovementOutcome, QueryMovement } from "../shared/movement.js";
import logoUrl from "./assets/deeplink_x_logo.jpg";
import {
  formatDate,
  number,
  rankText,
  useApi,
  type HistoryEventsPage,
  type HistorySummary,
  type PackageSnapshot,
  type QueryResult,
  type Run,
  type Summary,
} from "./api-client";
import { MetricChart, RankChart } from "./charts";
import {
  parseHistoryView,
  queryExplorerLink,
  selectedDateRange,
  sortMovements,
  type HistoryProfile,
  type HistoryRange,
  type MovementFilter,
  type MovementSort,
} from "./history-state";

function Status({ loading, error, children }: { loading: boolean; error: string | null; children: React.ReactNode }) {
  if (loading) return <div className="state-card" role="status">Loading permanent visibility data…</div>;
  if (error) return <div className="state-card error" role="alert"><strong>Dashboard data is unavailable.</strong><span>{error}</span></div>;
  return <>{children}</>;
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="state-card"><strong>{title}</strong><span>{children}</span></div>;
}

function Shell({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState(() => localStorage.getItem("deeplinkx-theme") ?? "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("deeplinkx-theme", theme);
  }, [theme]);
  const nav = [
    ["/", "Overview"],
    ["/history", "History"],
    ["/queries", "Queries"],
    ["/matrices", "Matrices"],
    ["/competitors", "Competitors"],
    ["/reports", "Reports"],
    ["/legacy", "Legacy"],
  ];
  return <div className="site-shell">
    <header className="topbar">
      <Link className="brand" to="/" aria-label="DeeplinkX visibility home"><img src={logoUrl} alt="" /><span>DeeplinkX</span><small>pub.dev visibility</small></Link>
      <nav aria-label="Dashboard sections">{nav.map(([href, label]) => <NavLink key={href} to={href} end={href === "/"}>{label}</NavLink>)}</nav>
      <div className="top-actions"><button className="theme-button" type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}>{theme === "dark" ? "☀" : "☾"}</button><a className="demo-link" href="https://deeplinkx.github.io/DeeplinkX/">Live demo <span aria-hidden="true">↗</span></a></div>
    </header>
    <main>{children}</main>
    <footer><p>Permanent, bounded pub.dev visibility evidence for DeeplinkX.</p><a href="https://pub.dev/packages/deeplink_x">View on pub.dev ↗</a></footer>
  </div>;
}

function Coverage({ run }: { run: Run }) {
  const coverage = run.coverage;
  if (!coverage?.total) return <Empty title="No compact-core coverage yet">The first materialized audit will populate these thresholds.</Empty>;
  const rows = [["Top 1", coverage.top_1], ["Top 3", coverage.top_3], ["Top 10", coverage.top_10]] as const;
  return <div className="coverage-list">{rows.map(([label, value]) => <div className="coverage-row" key={label}><span>{label}</span><div className="track"><i style={{ width: `${value / coverage.total * 100}%` }} /></div><strong>{value}<small>/{coverage.total}</small></strong></div>)}</div>;
}

function Overview() {
  const summary = useApi<Summary>("/api/v1/summary");
  const stats = useApi<{ snapshots: PackageSnapshot[] }>("/api/v1/stats?canonical=1");
  return <Status loading={summary.loading} error={summary.error}>{summary.data ? <>
    {(summary.data.catalog_sync?.status === "stale" || summary.data.storage.warning) && <div className="warning-banner" role="status"><strong>Freshness warning</strong><span>{summary.data.catalog_sync?.warning ?? summary.data.storage.warning}</span></div>}
    <section className="hero"><div><p className="eyebrow"><span /> Permanent release intelligence</p><h1>Developer search visibility, without the guesswork.</h1><p className="lede">Where DeeplinkX appears for compact pub.dev searches—provider by provider, release by release, with every visible report retained.</p></div><aside className="freshness" aria-label="Latest scan status"><span>Latest report</span><strong>{formatDate((summary.data.latest.pulse ?? summary.data.latest.full)?.report_date)}</strong><p><i />{summary.data.active_run ? `${summary.data.active_run.profile} · ${summary.data.active_run.status}` : summary.data.latest.pulse ? `Pulse · Top ${summary.data.latest.pulse.effective_depth}` : "Awaiting first scan"}</p></aside></section>
    <section className="signal-grid" aria-label="Package signals"><article><span>Published</span><strong>{summary.data.package_snapshot?.published_version ?? "—"}</strong><small>Local {summary.data.package_snapshot?.repository_version ?? "—"}</small></article><article><span>Pub points</span><strong>{number(summary.data.package_snapshot?.points)}</strong><small>of {number(summary.data.package_snapshot?.max_points)}</small></article><article><span>Likes</span><strong>{number(summary.data.package_snapshot?.likes)}</strong><small>Weekly snapshot</small></article><article><span>Rolling 30-day downloads</span><strong>{number(summary.data.package_snapshot?.downloads_30d)}</strong><small>Published metric</small></article></section>
    <section className="dashboard-grid"><article className="panel coverage-panel"><div className="panel-heading"><div><p className="kicker">Compact core</p><h2>Pulse coverage</h2></div><span>{summary.data.latest.pulse?.query_count ?? 0} selected queries</span></div>{summary.data.latest.pulse ? <Coverage run={summary.data.latest.pulse} /> : <Empty title="No pulse report yet">A manual or scheduled pulse will establish the first top-10 baseline.</Empty>}</article><article className="panel focus-panel"><p className="kicker">Evidence-led focus</p><h2>{summary.data.recommendations[0]?.class ?? "Awaiting first audit"}</h2><p>{summary.data.recommendations[0]?.rationale ?? "Recommendations appear only after a completed query is classified from stored evidence."}</p><div className="chips">{summary.data.recommendations.slice(0, 3).map((item) => <span key={`${item.run_id}:${item.query_id}`}>{item.query} · {item.rank === null ? "not visible" : `#${item.rank}`}</span>)}</div></article></section>
    <section className="panel trend-panel"><div className="panel-heading"><div><p className="kicker">Package signal</p><h2>Rolling 30-day downloads</h2></div><Link className="text-link" to="/history?profile=pulse&range=all">Open complete history →</Link></div><Status loading={stats.loading} error={stats.error}>{stats.data ? <MetricChart labels={stats.data.snapshots.map((item) => item.report_date ?? item.captured_at.slice(0, 10))} values={stats.data.snapshots.map((item) => item.downloads_30d)} label="Rolling 30-day downloads" color="#30d5f2" /> : null}</Status></section>
    <section className="method-note"><strong>Bounded evidence, honest interpretation.</strong><p>{summary.data.interpretation} Pulse and full trends remain separate.</p></section>
  </> : null}</Status>;
}

function useRuns(profile?: "pulse" | "full") {
  return useApi<{ runs: Run[] }>(`/api/v1/runs?limit=100${profile ? `&profile=${profile}` : ""}`);
}

function QueryExplorer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [profile, setProfile] = useState<"pulse" | "full">(() => searchParams.get("profile") === "full" ? "full" : "pulse");
  const runState = useRuns(profile);
  const [runId, setRunId] = useState(() => searchParams.get("run") ?? "");
  const [lane, setLane] = useState("all");
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState<QueryResult | null>(null);
  const requestedQuery = searchParams.get("query");
  const runs = runState.data?.runs ?? [];
  const activeRun = runs.some((run) => run.id === runId) ? runId : runs[0]?.id ?? "";
  const queries = useApi<{ queries: QueryResult[] }>(activeRun ? `/api/v1/runs/${activeRun}/queries` : null);
  const history = useApi<{ history: Array<{ report_date: string; rank: number | null }> }>(selected ? `/api/v1/queries/${selected.query_id}/history?profile=${profile}` : null);

  useEffect(() => {
    if (!requestedQuery || !queries.data) return;
    const match = queries.data.queries.find((query) => query.query_id === requestedQuery);
    if (match) setSelected(match);
  }, [queries.data, requestedQuery]);

  const filtered = useMemo(() => (queries.data?.queries ?? []).filter((item) => (lane === "all" || item.lane === lane) && item.query.toLowerCase().includes(term.toLowerCase())), [queries.data, lane, term]);
  const lanes = [...new Set((queries.data?.queries ?? []).map((item) => item.lane))].sort();
  const updateLocation = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) value ? next.set(key, value) : next.delete(key);
    setSearchParams(next, { replace: true });
  };

  return <section className="page-section"><header className="page-heading"><p className="eyebrow">Query explorer</p><h1>Every compact search, traceable.</h1><p>Filter normalized query results and inspect compatible rank history without treating rank as demand.</p></header><div className="filterbar"><label>Profile<select value={profile} onChange={(event) => { const value = event.target.value as "pulse" | "full"; setProfile(value); setRunId(""); setSelected(null); updateLocation({ profile: value, run: null, query: null }); }}><option value="pulse">Pulse · top 10</option><option value="full">Full · top 100</option></select></label><label>Report<select value={activeRun} onChange={(event) => { setRunId(event.target.value); setSelected(null); updateLocation({ run: event.target.value, query: null }); }}>{runs.map((run) => <option key={run.id} value={run.id}>{run.report_date} · {run.status}</option>)}</select></label><label>Lane<select value={lane} onChange={(event) => setLane(event.target.value)}><option value="all">All lanes</option>{lanes.map((item) => <option key={item}>{item}</option>)}</select></label><label className="search-label">Search<input value={term} onChange={(event) => setTerm(event.target.value)} type="search" placeholder="map deep link" /></label></div><Status loading={runState.loading || queries.loading} error={runState.error ?? queries.error}>{runs.length ? <div className="explorer-grid"><div className="table-wrap"><table><thead><tr><th>Query</th><th>Lane</th><th>Result</th><th>Depth</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.query_id} className={selected?.query_id === item.query_id ? "selected" : ""}><td><button className="table-button" type="button" onClick={() => { setSelected(item); updateLocation({ profile, run: activeRun, query: item.query_id }); }}>{item.query}<small>{item.query_id}</small></button></td><td><span className="tag">{item.lane}</span></td><td className={item.status === "failed" ? "bad" : item.rank && item.rank <= 3 ? "good" : ""}>{rankText(item)}</td><td>{item.actual_depth}/{item.requested_depth}</td></tr>)}</tbody></table></div><aside className="panel query-inspector">{selected ? <><p className="kicker">Selected query</p><h2>{selected.query}</h2><dl><div><dt>Product area</dt><dd>{selected.product_area}</dd></div><div><dt>Fit</dt><dd>{selected.product_fit}</dd></div><div><dt>Evidence</dt><dd>{selected.sources.map((source) => source.location).join(", ")}</dd></div></dl><Status loading={history.loading} error={history.error}>{history.data ? <RankChart values={history.data.history.map((item) => ({ label: item.report_date, rank: item.rank }))} /> : null}</Status></> : <Empty title="Select a query">Its evidence, scan result, and profile-specific rank trend will appear here.</Empty>}</aside></div> : <Empty title="No materialized report yet">The explorer activates after the first pulse or full report.</Empty>}</Status></section>;
}

function usePaginatedEvents(path: string | null) {
  const [state, setState] = useState<{ data: HistoryEventsPage | null; error: string | null; loading: boolean; loadingMore: boolean }>({ data: null, error: null, loading: Boolean(path), loadingMore: false });
  useEffect(() => {
    if (!path) {
      setState({ data: null, error: null, loading: false, loadingMore: false });
      return;
    }
    const controller = new AbortController();
    setState({ data: null, error: null, loading: true, loadingMore: false });
    fetch(path, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        const value = await response.json() as HistoryEventsPage & { error?: string };
        if (!response.ok) throw new Error(value.error ?? `Request failed with HTTP ${response.status}.`);
        return value;
      })
      .then((data) => setState({ data, error: null, loading: false, loadingMore: false }))
      .catch((error: unknown) => {
        if ((error as Error).name !== "AbortError") setState({ data: null, error: (error as Error).message, loading: false, loadingMore: false });
      });
    return () => controller.abort();
  }, [path]);

  const loadMore = async () => {
    if (!path || !state.data?.next_cursor || state.loadingMore) return;
    setState((current) => ({ ...current, loadingMore: true, error: null }));
    try {
      const separator = path.includes("?") ? "&" : "?";
      const response = await fetch(`${path}${separator}cursor=${encodeURIComponent(state.data.next_cursor)}`, { headers: { accept: "application/json" } });
      const value = await response.json() as HistoryEventsPage & { error?: string };
      if (!response.ok) throw new Error(value.error ?? `Request failed with HTTP ${response.status}.`);
      setState((current) => ({
        data: current.data ? { ...value, events: [...current.data.events, ...value.events] } : value,
        error: null,
        loading: false,
        loadingMore: false,
      }));
    } catch (error) {
      setState((current) => ({ ...current, error: (error as Error).message, loadingMore: false }));
    }
  };
  return { ...state, loadMore };
}

function movementName(outcome: MovementOutcome): string {
  return ({ improved: "Improved", dropped: "Dropped", found: "Found", lost_visibility: "Lost visibility", unchanged: "Unchanged", not_visible: "Not visible", withheld: "Withheld" })[outcome];
}

function movementChange(item: QueryMovement): string {
  if (item.outcome === "improved") return `+${item.positions_gained}`;
  if (item.outcome === "dropped") return `−${item.positions_lost}`;
  if (item.outcome === "found") return "Found";
  if (item.outcome === "lost_visibility") return "Lost";
  if (item.outcome === "withheld") return "Withheld";
  return "0";
}

function rankValue(value: number | null): string {
  return value === null ? "—" : `#${value}`;
}

function observedDelta(values: Array<number | null>): { start: number | null; end: number | null; delta: number | null } {
  const observed = values.filter((value): value is number => value !== null);
  const start = observed[0] ?? null;
  const end = observed.at(-1) ?? null;
  return { start, end, delta: start === null || end === null ? null : end - start };
}

function MetricPanel({ title, values, labels, color }: { title: string; values: Array<number | null>; labels: string[]; color: string }) {
  const change = observedDelta(values);
  return <article className="panel metric-panel"><div className="metric-heading"><div><p className="kicker">Package metric</p><h2>{title}</h2></div><dl><div><dt>Start</dt><dd>{number(change.start)}</dd></div><div><dt>End</dt><dd>{number(change.end)}</dd></div><div><dt>Delta</dt><dd className={change.delta !== null && change.delta < 0 ? "bad" : "good"}>{change.delta === null ? "—" : `${change.delta > 0 ? "+" : ""}${number(change.delta)}`}</dd></div></dl></div><MetricChart labels={labels} values={values} label={title} color={color} /></article>;
}

function History() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = parseHistoryView(searchParams);
  const allStats = useApi<{ snapshots: PackageSnapshot[] }>("/api/v1/stats?canonical=1");
  const latestDate = allStats.data?.snapshots.at(-1)?.report_date ?? null;
  const dates = selectedDateRange(view, latestDate);
  const needsLatest = view.range !== "all" && view.range !== "custom";
  const ready = !needsLatest || !allStats.loading;
  const rangeQuery = `${dates.from ? `&from=${dates.from}` : ""}${dates.to ? `&to=${dates.to}` : ""}`;
  const summaryPath = ready && !dates.error ? `/api/v1/history/summary?profile=${view.profile}${rangeQuery}` : null;
  const statsPath = ready && !dates.error ? `/api/v1/stats?canonical=1${rangeQuery}` : null;
  const summary = useApi<HistorySummary>(summaryPath);
  const stats = useApi<{ snapshots: PackageSnapshot[] }>(statsPath);
  const [movementFilter, setMovementFilter] = useState<MovementFilter>("all");
  const [sort, setSort] = useState<MovementSort>("change");
  const [descending, setDescending] = useState(true);
  const eventOutcomes = movementFilter === "all" ? "improved,dropped,found,lost_visibility" : movementFilter;
  const events = usePaginatedEvents(ready && !dates.error ? `/api/v1/history/events?profile=${view.profile}${rangeQuery}&outcome=${eventOutcomes}&limit=50` : null);

  useEffect(() => {
    if (searchParams.has("profile") && searchParams.has("range")) return;
    const next = new URLSearchParams(searchParams);
    if (!next.has("profile")) next.set("profile", view.profile);
    if (!next.has("range")) next.set("range", view.range);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, view.profile, view.range]);

  const setView = (updates: Partial<{ profile: HistoryProfile; range: HistoryRange; from: string; to: string }>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) next.set(key, value);
    if (updates.range && updates.range !== "custom") { next.delete("from"); next.delete("to"); }
    setSearchParams(next, { replace: true });
  };
  const netMovements = summary.data?.net?.movements ?? [];
  const filteredMovements = useMemo(() => sortMovements(netMovements.filter((item) => movementFilter === "all" || item.outcome === movementFilter), sort, descending), [netMovements, movementFilter, sort, descending]);
  const counts = summary.data?.net?.counts;
  const snapshots = stats.data?.snapshots ?? [];
  const metricLabels = snapshots.map((item) => item.report_date ?? item.captured_at.slice(0, 10));

  const changeSort = (nextSort: MovementSort) => {
    if (sort === nextSort) setDescending((value) => !value);
    else { setSort(nextSort); setDescending(nextSort === "change"); }
  };

  return <section className="page-section history-page">
    <header className="page-heading"><p className="eyebrow">Historical visibility</p><h1>What moved, and when.</h1><p>Compare compatible pub.dev snapshots, separate numeric rank drops from proven disappearance, and follow package metrics without turning them into demand claims.</p></header>
    <div className="history-controls" aria-label="Historical visibility filters">
      <label>Profile<select value={view.profile} onChange={(event) => setView({ profile: event.target.value as HistoryProfile })}><option value="pulse">Pulse · top 10</option><option value="full">Full · top 100</option></select></label>
      <fieldset><legend>UTC date range</legend><div className="segmented range-tabs">{(["30d", "90d", "1y", "all", "custom"] as HistoryRange[]).map((range) => <button type="button" key={range} aria-pressed={view.range === range} onClick={() => setView({ range })}>{range === "all" ? "All history" : range === "custom" ? "Custom" : range}</button>)}</div></fieldset>
      {view.range === "custom" && <div className="custom-dates"><label>From<input type="date" value={view.from} onChange={(event) => setView({ from: event.target.value })} /></label><label>To<input type="date" value={view.to} onChange={(event) => setView({ to: event.target.value })} /></label></div>}
    </div>
    {dates.error && <div className="state-card error" role="alert">{dates.error}</div>}
    <Status loading={summary.loading || (needsLatest && allStats.loading)} error={summary.error ?? allStats.error}>
      {summary.data ? <>
        <div className="range-context"><span>{summary.data.range.snapshot_count} compatible {view.profile} snapshots</span><strong>{summary.data.range.first_report_date ? `${formatDate(summary.data.range.first_report_date)} → ${formatDate(summary.data.range.last_report_date)}` : "No compatible reports in this range"}</strong></div>
        {summary.data.net ? <>
          <section className="movement-cards" aria-label="Net rank movement summary">
            <article className="movement-card improved"><span>Improved queries</span><strong>{counts?.improved ?? 0}</strong><small>{number(counts?.positions_gained)} positions gained</small></article>
            <article className="movement-card dropped"><span>Dropped queries</span><strong>{counts?.dropped ?? 0}</strong><small>{number(counts?.positions_lost)} positions lost</small></article>
            <article className="movement-card found"><span>Newly found</span><strong>{counts?.found ?? 0}</strong><small>Entered the completed depth</small></article>
            <article className="movement-card lost"><span>Lost visibility</span><strong>{counts?.lost_visibility ?? 0}</strong><small>Absence proven at depth</small></article>
          </section>
          <article className="panel history-table-panel"><div className="panel-heading"><div><p className="kicker">First-to-last net change</p><h2>{formatDate(summary.data.net.before.report_date)} to {formatDate(summary.data.net.after.report_date)}</h2></div><span>{counts?.withheld ?? 0} unsupported changes withheld</span></div><div className="segmented movement-tabs" role="group" aria-label="Movement outcome">{(["all", "improved", "dropped", "found", "lost_visibility"] as MovementFilter[]).map((outcome) => <button type="button" key={outcome} aria-pressed={movementFilter === outcome} onClick={() => setMovementFilter(outcome)}>{outcome === "lost_visibility" ? "Lost visibility" : outcome}</button>)}</div><div className="table-wrap"><table><thead><tr><th><button className="sort-button" type="button" onClick={() => changeSort("query")}>Query</button></th><th>Outcome</th><th><button className="sort-button" type="button" onClick={() => changeSort("before")}>Old rank</button></th><th><button className="sort-button" type="button" onClick={() => changeSort("after")}>New rank</button></th><th><button className="sort-button" type="button" onClick={() => changeSort("change")}>Change</button></th></tr></thead><tbody>{filteredMovements.map((item) => <tr key={item.query_id}><td><Link className="query-link" to={queryExplorerLink(view.profile, summary.data!.net!.after.id, item.query_id)}>{item.query}<small>{item.query_id}</small></Link></td><td><span className={`movement-badge ${item.outcome}`}>{movementName(item.outcome)}</span></td><td>{rankValue(item.before_rank)}</td><td>{rankValue(item.after_rank)}</td><td className={item.outcome === "improved" ? "good" : item.outcome === "dropped" ? "bad" : ""}>{movementChange(item)}</td></tr>)}</tbody></table>{!filteredMovements.length && <Empty title="No matching movements">Choose another outcome or date range.</Empty>}</div><div className="catalog-summary"><span>{summary.data.net.added.length} added</span><span>{summary.data.net.retired.length} retired</span><span>{summary.data.net.redefined.length} redefined</span><span>{counts?.unchanged ?? 0} unchanged</span><span>{counts?.not_visible ?? 0} not visible at either endpoint</span></div></article>
        </> : <Empty title={summary.data.range.snapshot_count === 1 ? "One compatible snapshot" : "No compatible snapshots"}>{summary.data.range.snapshot_count === 1 ? "At least two compatible reports are required to calculate movement." : "Try a wider range or the other profile."}</Empty>}

        <section className="history-section"><div className="section-heading"><div><p className="kicker">Adjacent transitions</p><h2>When movement happened</h2></div><span>Every compatible dated step</span></div>{summary.data.timeline.length ? <div className="transition-grid">{[...summary.data.timeline].reverse().map((item) => <article className="transition-card" key={`${item.before.id}:${item.after.id}`}><div><strong>{item.before.report_date} → {item.after.report_date}</strong><span>{item.after.published_version ? `Release ${item.after.published_version}` : "Version not captured"}</span></div><ul><li><b>{item.counts.improved}</b> improved</li><li><b>{item.counts.dropped}</b> dropped</li><li><b>{item.counts.found}</b> found</li><li><b>{item.counts.lost_visibility}</b> lost visibility</li></ul>{item.catalog_changed && <small>Catalog changed · {item.added} added, {item.retired} retired, {item.redefined} redefined</small>}</article>)}</div> : <Empty title="No adjacent transitions">This range needs at least two compatible snapshots.</Empty>}</section>

        <article className="panel event-panel"><div className="panel-heading"><div><p className="kicker">Movement event log</p><h2>Individual adjacent-snapshot changes</h2></div><span>{events.data?.total_events ?? 0} matching events</span></div><Status loading={events.loading} error={events.error}>{events.data?.events.length ? <><div className="table-wrap"><table><thead><tr><th>Transition</th><th>Query</th><th>Outcome</th><th>Rank change</th><th>Release</th></tr></thead><tbody>{events.data.events.map((event) => <tr key={`${event.before.id}:${event.after.id}:${event.movement.query_id}:${event.movement.outcome}`}><td>{event.before.report_date}<br /><span className="muted">to {event.after.report_date}</span></td><td><Link className="query-link" to={queryExplorerLink(view.profile, event.after.id, event.movement.query_id)}>{event.movement.query}<small>{event.movement.query_id}</small></Link></td><td><span className={`movement-badge ${event.movement.outcome}`}>{movementName(event.movement.outcome)}</span></td><td>{rankValue(event.movement.before_rank)} → {rankValue(event.movement.after_rank)} <b className={event.movement.outcome === "improved" ? "good" : event.movement.outcome === "dropped" ? "bad" : ""}>{movementChange(event.movement)}</b></td><td>{event.after.published_version ?? "—"}</td></tr>)}</tbody></table></div>{events.data.next_cursor && <button className="load-more" type="button" disabled={events.loadingMore} onClick={() => void events.loadMore()}>{events.loadingMore ? "Loading…" : "Load older events"}</button>}</> : <Empty title="No matching movement events">This range has no adjacent changes for the selected outcome.</Empty>}</Status></article>

        {summary.data.excluded_runs.length > 0 && <details className="excluded-runs"><summary>{summary.data.excluded_runs.length} observations excluded from rank comparison</summary><ul>{summary.data.excluded_runs.map((run) => <li key={run.id}><strong>{run.report_date}</strong> · {run.profile} · {run.reason}</li>)}</ul></details>}
        <section className="method-note"><strong>Dropped is not lost.</strong><p>{summary.data.interpretation}</p></section>
      </> : null}
    </Status>

    <section className="history-section"><div className="section-heading"><div><p className="kicker">Package metrics</p><h2>Published signals over time</h2></div><span>Independent scales · UTC snapshots</span></div><Status loading={stats.loading} error={stats.error}>{stats.data ? snapshots.length ? <div className="metric-grid"><MetricPanel title="Rolling 30-day downloads" labels={metricLabels} values={snapshots.map((item) => item.downloads_30d)} color="#30d5f2" /><MetricPanel title="Likes" labels={metricLabels} values={snapshots.map((item) => item.likes)} color="#70e3a0" /><MetricPanel title="Pub points" labels={metricLabels} values={snapshots.map((item) => item.points)} color="#7f8cff" /></div> : <Empty title="No package metrics in this range">Try a wider date range.</Empty> : null}</Status></section>
  </section>;
}

function latestReport(profile: "pulse" | "full") {
  const state = useRuns(profile);
  const run = state.data?.runs.find((item) => item.report_materialized) ?? null;
  const queries = useApi<{ queries: QueryResult[] }>(run ? `/api/v1/runs/${run.id}/queries` : null);
  return { run, state, queries };
}

function Matrices() {
  const { run, state, queries } = latestReport("full");
  const [view, setView] = useState<"provider" | "store" | "navigation">("provider");
  const rows = useMemo(() => {
    const grouped = new Map<string, QueryResult[]>();
    for (const query of queries.data?.queries ?? []) {
      const name = view === "store" ? query.tags.store : query.tags.provider;
      if (!name || (view === "navigation" && !query.tags.capability)) continue;
      grouped.set(name, [...(grouped.get(name) ?? []), query]);
    }
    return [...grouped.entries()].map(([name, items]) => ({ name, items, ranks: items.flatMap((item) => item.rank === null ? [] : [item.rank]) })).sort((a, b) => a.name.localeCompare(b.name));
  }, [queries.data, view]);
  return <section className="page-section"><header className="page-heading"><p className="eyebrow">Coverage matrices</p><h1>Provider and capability visibility.</h1><p>The full profile keeps app, store, and documented navigation terms separate.</p></header><div className="segmented" role="group" aria-label="Matrix type">{(["provider", "store", "navigation"] as const).map((item) => <button key={item} type="button" aria-pressed={view === item} onClick={() => setView(item)}>{item}</button>)}</div><Status loading={state.loading || queries.loading} error={state.error ?? queries.error}>{run ? <div className="matrix-grid">{rows.map((row) => <article className="panel matrix-card" key={row.name}><div><h2>{row.name}</h2><span>{row.ranks.length}/{row.items.length} visible</span></div><strong>{row.ranks.length ? `#${Math.min(...row.ranks)}` : "—"}<small>best rank</small></strong><ul>{row.items.slice(0, 6).map((item) => <li key={item.query_id}><span>{item.query}</span><b>{item.rank ? `#${item.rank}` : "—"}</b></li>)}</ul></article>)}</div> : <Empty title="No full report yet">Matrices populate after the first top-100 audit.</Empty>}</Status></section>;
}

function Competitors() {
  const { run, state } = latestReport("full");
  const competitors = useApi<{ competitors: Array<{ package_name: string; occurrence_count: number; best_rank: number; median_rank: number; category: string }> }>(run ? `/api/v1/runs/${run.id}/competitors` : null);
  return <section className="page-section"><header className="page-heading"><p className="eyebrow">Competitor analysis</p><h1>Repeated packages across the catalog.</h1><p>Frequency is appearance across bounded queries—not market share, popularity, or demand.</p></header><Status loading={state.loading || competitors.loading} error={state.error ?? competitors.error}>{run ? <div className="table-wrap"><table><thead><tr><th>Package</th><th>Query appearances</th><th>Best</th><th>Median</th><th>Relevant category</th></tr></thead><tbody>{competitors.data?.competitors.map((item) => <tr key={item.package_name}><td><a href={`https://pub.dev/packages/${item.package_name}`}>{item.package_name} ↗</a></td><td>{item.occurrence_count}</td><td>#{item.best_rank}</td><td>{item.median_rank}</td><td><span className="tag">{item.category}</span></td></tr>)}</tbody></table></div> : <Empty title="No full report yet">Competitor aggregates are materialized with the first full audit.</Empty>}</Status></section>;
}

function Reports() {
  const runState = useRuns();
  const [before, setBefore] = useState("");
  const [after, setAfter] = useState("");
  const comparison = useApi<{ movements: Array<{ query_id: string; query: string; before_rank: number | null; after_rank: number | null; movement: string }>; added: unknown[]; retired: unknown[]; redefined: unknown[]; unsupported_losses: unknown[] }>(before && after ? `/api/v1/compare?before=${before}&after=${after}` : null);
  const runs = runState.data?.runs.filter((run) => run.report_materialized) ?? [];
  return <section className="page-section"><header className="page-heading"><p className="eyebrow">Immutable reports</p><h1>Permanent reports and honest movement.</h1><p>Only matching profile/depth observations and unchanged definitions enter rank movement.</p></header><Status loading={runState.loading} error={runState.error}>{runs.length ? <><div className="report-grid">{runs.map((run) => <article className="panel report-card" key={run.id}><span className={`status ${run.status}`}>{run.status}</span><p>{run.profile} · top {run.effective_depth}</p><h2>{formatDate(run.report_date)}</h2><small>{run.completed_count}/{run.query_count} queries complete</small><div className="report-actions"><Link to={`/reports/${run.id}`}>Open report</Link><a href={`/api/v1/exports/${run.id}/markdown`}>Markdown</a><a href={`/api/v1/exports/${run.id}/csv`}>CSV</a><a href={`/api/v1/exports/${run.id}/json`}>JSON</a></div></article>)}</div><article className="panel comparison-panel"><div className="panel-heading"><div><p className="kicker">Compatible comparison</p><h2>Compare two materialized runs</h2></div></div><div className="filterbar"><label>Before<select value={before} onChange={(event) => setBefore(event.target.value)}><option value="">Choose a run</option>{runs.map((run) => <option key={run.id} value={run.id}>{run.profile} · top {run.effective_depth} · {run.report_date}</option>)}</select></label><label>After<select value={after} onChange={(event) => setAfter(event.target.value)}><option value="">Choose a run</option>{runs.map((run) => <option key={run.id} value={run.id}>{run.profile} · top {run.effective_depth} · {run.report_date}</option>)}</select></label></div>{comparison.error && <div className="state-card error">{comparison.error}</div>}{comparison.data && <div className="comparison-summary"><span>{comparison.data.movements.length} comparable</span><span>{comparison.data.added.length} added</span><span>{comparison.data.retired.length} retired</span><span>{comparison.data.redefined.length} redefined</span><span>{comparison.data.unsupported_losses.length} unsupported losses withheld</span></div>}</article></> : <Empty title="No reports yet">Production migration and the first pulse will populate the permanent archive.</Empty>}</Status></section>;
}

function ReportDetail() {
  const { runId = "" } = useParams();
  const detail = useApi<{ run: Run; package_snapshot: PackageSnapshot | null; exports: Array<{ artifact_type: string; filename: string; content_hash: string }> }>(`/api/v1/runs/${runId}`);
  const queries = useApi<{ queries: QueryResult[] }>(`/api/v1/runs/${runId}/queries`);
  return <section className="page-section"><Status loading={detail.loading || queries.loading} error={detail.error ?? queries.error}>{detail.data ? <><header className="page-heading"><p className="eyebrow">{detail.data.run.profile} · top {detail.data.run.effective_depth}</p><h1>{formatDate(detail.data.run.report_date)}</h1><p>{detail.data.run.status} · {detail.data.run.completed_count}/{detail.data.run.query_count} completed · catalog {detail.data.run.catalog_version}</p></header><div className="export-bar">{detail.data.exports.map((item) => <a key={item.artifact_type} href={`/api/v1/exports/${runId}/${item.artifact_type}`}>{item.filename}</a>)}</div><div className="table-wrap"><table><thead><tr><th>Query</th><th>Lane</th><th>Result</th><th>Depth</th></tr></thead><tbody>{queries.data?.queries.map((item) => <tr key={item.query_id}><td>{item.query}</td><td><span className="tag">{item.lane}</span></td><td>{rankText(item)}</td><td>{item.actual_depth}/{item.requested_depth}</td></tr>)}</tbody></table></div></> : null}</Status></section>;
}

function LegacyArchive() {
  const archive = useApi<{ documents: Array<{ id: string; document_type: string; filename: string; report_date: string; source_hash: string }> }>("/api/v1/legacy");
  return <section className="page-section"><header className="page-heading"><p className="eyebrow">Permanent legacy archive</p><h1>The history before automation.</h1><p>Original dated reports and comparisons retain source hashes and migration provenance.</p></header><Status loading={archive.loading} error={archive.error}>{archive.data?.documents.length ? <div className="report-grid">{archive.data.documents.map((item) => <article className="panel report-card" key={item.id}><p>{item.document_type}</p><h2>{item.filename}</h2><small>{formatDate(item.report_date)} · {item.source_hash.slice(0, 12)}</small><a className="standalone-link" href={`/api/v1/legacy/${item.id}`}>Open archived source</a></article>)}</div> : <Empty title="Migration not completed yet">Repository reports stay in place until every document is verified in production.</Empty>}</Status></section>;
}

export function App() {
  return <Shell><Routes><Route path="/" element={<Overview />} /><Route path="/history" element={<History />} /><Route path="/queries" element={<QueryExplorer />} /><Route path="/matrices" element={<Matrices />} /><Route path="/competitors" element={<Competitors />} /><Route path="/reports" element={<Reports />} /><Route path="/reports/:runId" element={<ReportDetail />} /><Route path="/legacy" element={<LegacyArchive />} /><Route path="*" element={<section className="page-section"><Empty title="Page not found"><Link to="/">Return to the overview.</Link></Empty></section>} /></Routes></Shell>;
}
