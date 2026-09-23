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
  const generic=analyze("outbound_link_builder","Build universal links for external applications.","Handles encoding errors when building URLs.");
  expect(generic.capability_category).not.toBe("inbound links/routing");expect(generic.actions).toContain("buildUrl");
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
 // Synthetic evidence fixtures exercise decisions; package names are regression labels, not live README snapshots.
 it("recognizes package-owned actions even when metadata describes another main purpose",()=>{
  const notifications=analyze("smart_notification_listener","A notification listener and logging utility.","The plugin can launch installed apps by package name.");
  expect(notifications.relationship).toBe("direct");expect(notifications.actions).toContain("appLauncher");
  const time=analyze("sync_time_ntp_totalxsoftware","An NTP clock synchronization utility.","The package can open external URLs in the default browser.");
  expect(time.relationship).toBe("adjacent");expect(time.actions).toContain("openUrl");
  expect(time.capabilities.every(c=>c.deeplinkx_apis.length===0)).toBe(true);
  const payment=analyze("hyperpay_plugin","Payment authentication SDK with REST API support.","The plugin can launch external apps to complete payment.");
  expect(payment.actions).toContain("appLauncher");expect(payment.relationship).toBe("direct");
  const map=analyze("embedded_map","An embedded map widget SDK.","Launch directions in external maps.");
  expect(map.actions).toContain("mapLauncher");
 });
 it("excludes setup operations without vetoing a separate genuine action",()=>{
  const result=analyze("smart_notification_listener","A notification logging plugin.","Open Info.plist and add WhatsApp URL schemes. Share pubspec.lock files. The plugin can open WhatsApp.");
  expect(result.actions).toEqual(["open"]);
  expect(result.capabilities[0]?.evidence).toBe("The plugin can open WhatsApp.");
  expect(analyze("hyperpay_plugin","Payment authentication SDK.","Open Info.plist to register a redirect URL. Handle incoming callback links.").capabilities).toHaveLength(0);
 });
 it("distinguishes logging transports and setup from opening a provider app",()=>{
  for(const provider of ["Slack","Telegram"]){
   const transport=analyze("logging_transport","Logging transport integration.",`Send messages to ${provider} through its API. Open ${provider} to create a webhook or BotFather bot token.`);
   expect(transport.relationship).toBe("noise");expect(transport.capabilities).toHaveLength(0);
   const launch=analyze("logging_transport","Logging transport integration.",`The package can open ${provider} app for viewing messages.`);
   expect(launch.actions).toEqual(["open"]);expect(launch.relationship).toBe("direct");
  }
 });
 it("keeps internal routing and ambiguous API names out of external capabilities",()=>{
  const menu=analyze("draggable_menu","A draggable menu widget.","Open menu. Share lockfiles with collaborators. Internal routing uses Navigator.pushNamed to open pages.");
  expect(menu.capabilities).toHaveLength(0);expect(menu.relationship).toBe("unknown");
  const typed=analyze("typed_deep_links","Type safe incoming deep links and internal routing.","Generate app links for Navigator routes. Handle incoming universal links.");
  expect(typed.relationship).toBe("adjacent");expect(typed.actions).not.toContain("buildUrl");
  const ambiguous=analyze("sync_time_ntp_totalxsoftware","NTP time synchronization.","Methods: open(), share(), launch().");
  expect(ambiguous.relationship).toBe("unknown");expect(ambiguous.capabilities).toHaveLength(0);
 });
 it("requires action-local targets instead of combining unrelated documentation sections",()=>{
  const result=analyze("mixed_actions","Integration with WhatsApp and Telegram.","Open a local file. WhatsApp configuration. Send diagnostic records. Telegram text support. Share images to WhatsApp.");
  expect(result.actions).toEqual(["shareFiles"]);
  expect(result.capabilities[0]?.migration).toBe("unsupported");
  const generic=analyze("browser_links","Open external URLs.","Supported URL examples include WhatsApp and Telegram.");
  expect(generic.actions).toEqual(["openUrl"]);
  expect(generic.capabilities[0]?.deeplinkx_apis).toEqual([]);
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
