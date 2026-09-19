import { describe,it,expect } from "vitest";
import catalog from "../catalog/catalog-v3.json";
import { analyzePackage,readmeText } from "../src/shared/competitor-analysis.js";
import { directoryOptions,filterDirectory } from "../src/worker/intelligence.js";
import { canonicalPublicRequest } from "../src/worker/cache.js";
import type { IntelligencePackage, ProductCapability } from "../src/shared/intelligence.js";
const publicCacheUrl=(url:URL)=>{const request=canonicalPublicRequest(new Request(url));return request?new URL(request.url):null;};
const inventory=catalog.capabilities as ProductCapability[];
const analyze=(name:string,description:string,documentation="")=>analyzePackage({name,description,topics:[],documentation,source_url:`https://pub.dev/api/packages/${name}`},inventory);
describe("capability discovery",()=>{
 it("covers every public action and the requested app/store variants",()=>{
  for(const term of ["whatsapp share","whatsapp share text","telegram profile","telegram open profile","play store app page","play store open app page","ios app store review"]) expect(catalog.queries.some(q=>q.query.toLowerCase()===term)).toBe(true);
  expect(inventory).toHaveLength(166);
  for(const action of inventory) expect(action.query_ids.length).toBeGreaterThan(0);
  expect(catalog.queries.some(q=>q.query==="WhatsApp macos")).toBe(false);
  expect(inventory.find(c=>c.api==="Telegram.sendMessageByPhoneNumber")?.documentation_warnings.length).toBe(1);
 });
 it("recognizes outbound universal link builders with honest migration gaps",()=>{
  const result=analyze("whatsapp_unilink","Dart package helping your app interact with WhatsApp via HTTP links (universal links). Works with Flutter.","Create a WhatsApp link to start a chat with a phone number and prefilled text. Build links as a String or URI in pure Dart.");
  expect(result.relationship).toBe("direct");expect(result.capability_category).not.toBe("inbound links/routing");
  expect(result.capabilities).toEqual(expect.arrayContaining([expect.objectContaining({action:"chat",deeplinkx_apis:["WhatsApp.chat"]}),expect.objectContaining({action:"buildUrl",migration:"unsupported"})]));
  expect(result.migration_status).toBe("partial");expect(result.expansion).toBe(true);
 });
 it("separates text and file sharing and multiple providers",()=>{
  const result=analyze("social_sharing","Share text, images and files to WhatsApp and Telegram.");
  expect(result.relationship).toBe("direct");expect(result.expansion).toBe(true);
  expect(result.capabilities.filter(c=>c.action==="shareFiles").every(c=>c.migration==="unsupported")).toBe(true);
  expect(result.providers).toEqual(expect.arrayContaining(["WhatsApp","Telegram"]));
 });
 it("does not infer unrelated provider actions from a different section",()=>{
  const result=analyze("mixed_links","Open WhatsApp and Telegram.","Telegram open profile. WhatsApp share text.");
  expect(result.capabilities.some(c=>c.provider==="WhatsApp"&&c.action==="openProfile")).toBe(false);
  const store=analyze("store_redirect","Redirect users to an app page in Google Play Store.","Share this package. Add a dependency to the pubspec.yaml file. Create a new Flutter project.");
  expect(store.actions).not.toContain("shareFiles");expect(store.actions).not.toContain("buildUrl");
  const maps=analyze("map_launcher","Find installed maps and launch directions.","Supported: NAVER Map. Waze map.");
  expect(maps.capabilities.some(c=>c.action==="view")).toBe(false);
 });
 it("keeps actual inbound handlers adjacent and UI/backend packages outside direct competitors",()=>{
  expect(analyze("app_links","Handle incoming universal links and custom URL schemes.").relationship).toBe("adjacent");
  expect(analyze("iconify_flutter_plus","100 open source icon sets for Flutter", "WhatsApp icons and Telegram share icons").relationship).toBe("noise");
  expect(analyze("whatsapp_cloud","WhatsApp Cloud API for sending messages.").relationship).toBe("noise");
  expect(analyze("chat_bubbles","WhatsApp chat bubbles UI").relationship).toBe("noise");
  expect(analyze("flutter_google_maps_webservices","Google maps web services for flutter (Geocoding, Places, Directions, Distance Matrix)").relationship).toBe("noise");
  expect(analyze("tmap_flutter_sdk","A Flutter plugin for TMAP (SK Open API) Vector Map v3. Supports markers and route planning.").relationship).toBe("noise");
  expect(analyze("apple_map_snapshotter","Generate static Apple Maps snapshots on iOS using MapKit.").relationship).toBe("noise");
 });
 it("isolates README evidence from dependencies and scripts",()=>{
  expect(readmeText('<section class="tab-content detail-tab-readme"><p>Share WhatsApp text</p><script>noise()</script></section><aside>Telegram profile</aside>')).toBe("Share WhatsApp text");
  expect(()=>readmeText("changed HTML")).toThrow(/container/);
 });
});
describe("directory ordering and cache keys",()=>{
 const base={...analyze("whatsapp_links","Share WhatsApp text"),package_name:"a",downloads_30d:100,likes:4,points:80,max_points:160,published_at:"2020-01-01",platforms:["android"],relevant_occurrence_count:2,relevant_best_rank:4} as IntelligencePackage;
 const items=[base,{...base,package_name:"b",downloads_30d:20,points:90,max_points:100},{...base,package_name:"c",downloads_30d:null}];
 it("puts missing values last in both directions and normalizes scores",()=>{
  const opts=directoryOptions(new URL("https://test/api/v1/competitors"));
  expect(filterDirectory(items,opts).map(i=>i.package_name)).toEqual(["a","b","c"]);
  expect(filterDirectory(items,{...opts,order:"asc"}).map(i=>i.package_name)).toEqual(["b","a","c"]);
  expect(filterDirectory(items,{...opts,sort:"score"}).map(i=>i.package_name)).toEqual(["b","a","c"]);
 });
 it("applies provider and platform filters before pagination",()=>{
  const opts=directoryOptions(new URL("https://test/api/v1/competitors?provider=Telegram&platform=android"));expect(filterDirectory(items,opts)).toHaveLength(0);
  expect(()=>directoryOptions(new URL("https://test/api/v1/competitors?sort=sql"))).toThrow();
 });
 it("canonicalizes defaults and isolates relevant filter variants",()=>{
  expect(publicCacheUrl(new URL("https://test/api/v1/competitors?sort=downloads&page=01&view=direct&ignored=x"))?.href).toBe("https://test/api/v1/competitors");
  expect(publicCacheUrl(new URL("https://test/api/v1/competitors?provider=Telegram&action=openProfile"))?.search).toBe("?provider=Telegram&action=openProfile");
 });
});
