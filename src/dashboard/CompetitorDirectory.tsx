import { Fragment, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi, number, formatDate } from "./api-client.js";
import { DIRECTORY_SORTS, type IntelligencePackage } from "../shared/intelligence.js";

interface Directory {
  competitors: IntelligencePackage[]; total: number; page: number; limit: number;
  coverage: {registered:number;classified:number;unresolved:number;partial:number;supplemental_queries:number;deferred_queries:number;jobs:Array<{status:string;count:number}>};
  facets: {providers:string[];actions:string[];platforms:string[]};product_commit:string;
}
function PackageEvidence({name}:{name:string}) {
  const state=useApi<{package:IntelligencePackage;discoveries:Array<{query:string|null;position:number|null;captured_at:string;source_url:string}>}>(`/api/v1/competitors/${name}`);
  if (state.loading) return <p role="status">Loading evidence…</p>;
  if (state.error) return <p role="alert">{state.error}</p>;
  const item=state.data?.package;
  return <div className="competitor-detail"><p>{item?.description}</p><p>{item?.rationale}</p>
    <p>Review: {item?.review_status.replaceAll("_"," ")} · Metadata: {formatDate(item?.metadata_captured_at)} · Metrics: {formatDate(item?.metrics_captured_at)}</p>
    {item?.capabilities.map((capability)=><article key={`${capability.provider}:${capability.action}`}><strong>{capability.provider} · {capability.action}</strong>
      <p>{capability.deeplinkx_apis.length ? `DeeplinkX: ${capability.deeplinkx_apis.join(", ")}` : "No matching DeeplinkX action established"} · {capability.migration.replaceAll("_"," ")}</p>
      <blockquote>{capability.evidence} <a href={capability.source_url}>Source ↗</a></blockquote><ul>{capability.caveats.map((c)=><li key={c}>{c}</li>)}</ul></article>)}
    <p>Observed queries</p><ul>{state.data?.discoveries.slice(0,12).map((e,i)=><li key={i}><a href={e.source_url}>{e.query??"Manually supplied package"}</a>{e.position?` · #${e.position}`:""} · {formatDate(e.captured_at)}</li>)}</ul>
  </div>;
}

export function CompetitorDirectory() {
  const [params,setParams]=useSearchParams();
  const [expanded,setExpanded]=useState<string|null>(null);
  const state=useApi<Directory>(`/api/v1/competitors?${params.toString()}`);
  const data=state.data;
  const update=(key:string,value:string)=>{const next=new URLSearchParams(params);value?next.set(key,value):next.delete(key);if(key!=="page")next.delete("page");setParams(next);};
  const select=(key:string,label:string,values:string[],fallback="")=><label>{label}<select aria-label={label} value={params.get(key)??fallback} onChange={(event)=>update(key,event.target.value)}>{!fallback&&<option value="">All</option>}{values.map((value)=><option key={value} value={value}>{value.replaceAll("_"," ")}</option>)}</select></label>;
  return <section className="page-section"><header className="page-heading"><p className="eyebrow">Competitor discovery</p><h1>Alternatives and opportunities.</h1><p>Compare external-app actions, migration caveats, and package metrics. Downloads count package downloads over 30 days; search appearances measure bounded visibility.</p></header>
    <div className="segmented" role="group" aria-label="Competitor view">{["direct","adjacent","expansion","unresolved","noise","all"].map((view)=><button key={view} type="button" aria-pressed={(params.get("view")??"direct")===view} onClick={()=>update("view",view)}>{view[0].toUpperCase()+view.slice(1)}</button>)}</div>
    <div className="competitor-filters">
      <label>Package search<input aria-label="Package search" value={params.get("q")??""} onChange={(e)=>update("q",e.target.value)} placeholder="Package or description" /></label>
      {select("provider","App or store",data?.facets.providers??[])}{select("action","Action",data?.facets.actions??[])}{select("platform","Platform",data?.facets.platforms??[])}
      {select("relationship","Relationship",["direct","adjacent","noise","unknown"])}{select("migration","Migration",["supported","partial","unsupported","needs_review"])}
      {select("review","Review status",["reviewed","rule_matched","needs_review"])}
      <label>Release age<select aria-label="Release age" value={params.get("age_months")??""} onChange={(e)=>update("age_months",e.target.value)}><option value="">Any age</option>{[12,24,36].map((age)=><option value={age} key={age}>At least {age} months</option>)}</select></label>
      {select("sort","Sort by",[...DIRECTORY_SORTS],"downloads")}{select("order","Direction",["desc","asc"],"desc")}
    </div>
    {state.error&&<p role="alert" className="warning-banner">{state.error}</p>}{state.loading&&<p role="status">Loading competitors…</p>}
    {data&&<><div className="competitor-summary"><article><span>Registered candidates</span><strong>{number(data.coverage.registered)}</strong></article><article><span>Evidence assessed</span><strong>{number(data.coverage.classified)}</strong></article><article><span>Unresolved</span><strong>{number(data.coverage.unresolved)}</strong></article><article><span>Partial refreshes</span><strong>{number(data.coverage.partial)}</strong></article></div>
      <p className="muted">Background work: {data.coverage.jobs.map((j)=>`${number(j.count)} ${j.status}`).join(" · ")||"Not started"}. Supplemental queries: {data.coverage.supplemental_queries}; deferred: {data.coverage.deferred_queries}. An old release alone does not establish abandonment.</p>
      <div className="table-wrap"><table className="directory-table"><thead><tr><th>Package / actions</th><th>Migration</th><th>30-day downloads</th><th>Likes</th><th>Pub points</th><th>Latest release</th><th>Relevant appearances</th><th>Best rank</th></tr></thead><tbody>{data.competitors.map((item)=><Fragment key={item.package_name}><tr><td><a href={`https://pub.dev/packages/${item.package_name}`}>{item.package_name} ↗</a><small>{item.providers.join(", ")||item.capability_category}</small><small>{item.actions.join(", ")||"Needs evidence review"}</small><button className="evidence-toggle" type="button" aria-expanded={expanded===item.package_name} onClick={()=>setExpanded(expanded===item.package_name?null:item.package_name)}>Evidence and comparison</button></td>
        <td><span className={`tag relationship-${item.relationship}`}>{item.migration_status.replaceAll("_"," ")}</span>{item.expansion&&<small>Feature opportunity</small>}</td>
        <td>{number(item.downloads_30d)}<small>{item.metrics_captured_at?formatDate(item.metrics_captured_at):"Not captured"}{item.metrics_error||item.metrics_captured_at&&Date.now()-Date.parse(item.metrics_captured_at)>8*86400000?" · stale":""}</small></td><td>{number(item.likes)}</td><td>{number(item.points)} / {number(item.max_points)}</td>
        <td>{item.published_version??"—"}<small>{formatDate(item.published_at)}</small>{item.published_at&&<small>{Math.max(0,Math.floor((Date.now()-Date.parse(item.published_at))/86400000))} days ago</small>}</td>
        <td>{number(item.relevant_occurrence_count)}</td><td>{item.relevant_best_rank===null?"—":`#${item.relevant_best_rank}`}</td></tr>
        {expanded===item.package_name&&<tr><td colSpan={8}><PackageEvidence name={item.package_name}/></td></tr>}</Fragment>)}</tbody></table></div>
      {!data.competitors.length&&<p>No packages match these filters.</p>}
      <div className="directory-pagination"><button disabled={data.page<=1||state.loading} onClick={()=>update("page",String(data.page-1))}>Previous</button><span>{number(data.total)} matches · Page {data.page} of {Math.max(1,Math.ceil(data.total/data.limit))}</span><button disabled={data.page*data.limit>=data.total||state.loading} onClick={()=>update("page",String(data.page+1))}>Next</button></div>
    </>}
  </section>;
}
