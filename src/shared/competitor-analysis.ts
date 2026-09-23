import { semanticText } from "./catalog.js";
import type { CapabilityMatch, PackageAnalysis, ProductCapability } from "./intelligence.js";

export const ANALYSIS_VERSION = "capabilities-v2.4";

export interface AnalysisEvidence {
  name: string;
  description: string;
  topics: string[];
  documentation?: string;
  source_url: string;
  documentation_url?: string;
}

const metaText = semanticText;
const contains = (text: string, phrase: string) => (` ${semanticText(text)} `).includes(` ${semanticText(phrase)} `);

export function plausibleOutbound(input: AnalysisEvidence): boolean {
  return /(?:link|launch|share|sharing|navigation|directions|installed|availability|redirect|intent|whatsapp|telegram|social)/i
    .test(`${input.name} ${input.description} ${input.topics.join(" ")}`);
}

export function analyzePackage(input: AnalysisEvidence, inventory: ProductCapability[]): PackageAnalysis {
  const metadata = `${input.name.replaceAll("_", " ")}. ${input.description}. ${input.topics.join(" ")}`;
  const text = `${metadata}\n${input.documentation ?? ""}`;
  const normalized = semanticText(text);
  const meta = semanticText(metadata);
  const chunks = [input.description, input.documentation ?? ""].flatMap((value) => value.split(/\n|(?<=[.!?;])\s+|\s+but\s+/i))
    .map((line) => line.trim()).filter(Boolean);
  const providers = [...new Set(inventory.map((item) => item.provider))].filter((provider) => contains(text, provider));
  const matches: CapabilityMatch[] = [];
  const genericShare = /platform share (ui|dialog)|system share sheet|native share dialog/.test(metaText(metadata));
  const noise = /\b(?:icon(?:s|ify)?|font(?:s)?|ui kit|chat bubbles|state management|database|logger|logging)\b/.test(meta);
  const pureNoise = /\b(?:icon pack|icons pack|icon set|icons set|iconify|font icons|brand icons|launcher icon|dynamic icon|chat bubbles|state management|database|logging)\b/.test(meta);
  const backend = /\b(?:cloud api|business api|rest api|web services?|webservices|directions api|place apis|chatbot|chat bot|bot api|authentication|otp verification)\b/.test(meta);
  const embeddedMap = /\b(?:vector map|map control|map widgets?|maps? sdk|map snapshots?|static apple maps snapshots|drawing routes|map previews)\b/.test(meta)
    && !/\b(?:launch\w*|external|installed maps|maps installed)\b/.test(meta);
  // Metadata labels describe context, not a package-wide veto. Each action must
  // have an operation and target in the same evidence span. Setup instructions,
  // API transports and inbound/internal routing are not external-app actions.
  function externalEvidence(chunk: string): boolean {
    const value = semanticText(chunk);
    if (/\b(?:info plist|androidmanifest xml|pubspec (?:yaml|lock)|lockfiles?|lock files?|gradle|podfile|readme|xcode project|terminal|command prompt)\b/.test(value)) return false;
    if (/\b(?:icon(?:s|ify)?|font icons|chat bubbles|icon sets?|icon packs?)\b/.test(value)) return false;
    if (/\b(?:cloud api|business api|rest api|web services?|webhooks?|bot api|chatbots?|bot token|botfather|http requests?|api endpoints?)\b/.test(value)) return false;
    if (/\b(?:through|via|using) (?:its |the |an? )?api\b|\b(?:logging|log) transports?\b/.test(value)) return false;
    if (/\b(?:send|sending|deliver|delivering|forward|forwarding)\b.{0,60}\b(?:logs?|log messages|log records|diagnostics|telemetry)\b/.test(value)) return false;
    if (/\b(?:incoming|inbound|receiv\w*|internal rout\w*|in app navigat\w*|navigator|pushnamed)\b/.test(value)) return false;
    if (/\b(?:snapshots?|map widgets?|map control|vector map|embedded maps?)\b/.test(value)
      && !/\b(?:external|installed) (?:map|maps|app|apps)\b/.test(value)) return false;
    if (/\b(?:does not|doesn t|cannot|can t|not supported|unsupported)\b/.test(value)) return false;
    // An example delegated to another library does not establish package ownership.
    if (/\b(?:using|via|with|import|dependency|dependencies)\b.{0,35}\b(?:url launcher|share plus|map launcher)\b/.test(value)) return false;
    return true;
  }
  const launch = /\b(?:launch(?:es|ing)?|open(?:s|ing)?|redirect(?:s|ing)?)\b/.test(normalized);
  const outbound = /\b(?:share|sharing|send|sending|chat|interact|build|building|create|creating|generate|generating)\b/.test(normalized);
  const inbound = chunks.some((chunk) => /\b(?:receiv\w*|handl\w*|rout\w*)(?: (?:incoming|inbound|deep|universal|app|custom|url|uri|scheme|and|or)){0,6} (?:links?|urls?|uris?|schemes?)\b|\b(?:incoming|inbound) (?:deep |universal |app )?(?:links?|urls?)\b|\b(?:links?|urls?|uris?|schemes?) (?:handler|receiver|router)\b/.test(semanticText(chunk)));

  function add(provider: string, action: string, expression: RegExp, apiAction?: string, extra: string[] = [], requires?: RegExp) {
    const qualifies = (chunk: string) => externalEvidence(chunk) && expression.test(semanticText(chunk)) && (!requires || requires.test(semanticText(chunk)));
    const evidence = chunks.find((chunk) => qualifies(chunk) && (provider === "General" || contains(chunk, provider)));
    if (!evidence) return;
    const apis = inventory.filter((capability) => capability.provider === provider && capability.action === (apiAction ?? action));
    matches.push({ provider, action, evidence: evidence.slice(0, 600),
      source_url: input.description.includes(evidence) ? input.source_url : input.documentation_url ?? input.source_url,
      deeplinkx_apis: apis.map((capability) => capability.api),
      migration: apis.length ? "partial" : "unsupported",
      caveats: ["Documentation establishes an overlap hypothesis; validate parameters, platform behavior, and fallback semantics before migrating.", ...extra],
    });
  }

  for (const provider of genericShare ? [] : providers) {
    const capabilities = inventory.filter((item) => item.provider === provider);
    if (launch) add(provider, "open", /\b(?:launch(?:es|ing)?|open(?:s|ing)?|redirect(?:s|ing)?)\b(?! source)/);
    if (outbound) {
      if (/\b(?:shar\w*|send\w*)\b/.test(normalized) && /\b(?:text|message|links?|urls?)\b/.test(normalized)) {
        add(provider, "shareText", /\b(?:shar\w*|send\w*)\b.{0,90}\b(?:text|messages?|links?|urls?)\b/, "shareText");
      }
      if (/\b(?:chat|phone number|click to chat)\b/.test(normalized)) add(provider, "chat", /\b(?:open\w*|start\w*|launch\w*|creat\w*|click to)\b.{0,90}\bchat\b/);
      if (/\b(?:shar\w*|send\w*)\b/.test(normalized) && /\b(?:files?|images?|videos?|media|stories|stickers?)\b/.test(normalized)) {
        add(provider, "shareFiles", /\b(?:files?|images?|videos?|media|stories|stickers?)\b/, "shareFiles", ["DeeplinkX text/URL actions do not establish native file, media, or story sharing support."], /\b(?:shar\w*|send\w*)\b/);
      }
    }
    for (const capability of capabilities.filter((c) => !["open", "shareText", "shareFiles", "chat"].includes(c.action))) {
      const phrase = capability.phrases.find((value) => contains(normalized, value));
      if (!phrase || !(launch || outbound || /\b(?:directions|navigation|map launcher)\b/.test(normalized))) continue;
      add(provider, capability.action, new RegExp(`\\b${semanticText(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`), undefined, [], /\b(?:launch\w*|open\w*|show\w*|view\w*|search\w*|navigat\w*|directions|send\w*|creat\w*|join\w*|watch\w*|rate\w*)\b/);
    }
  }
  if (/\b(?:map launcher|maps launcher|launch maps|launch directions|available maps installed|maps installed)\b/.test(normalized)) {
    add("General", "mapLauncher", /\b(?:map launcher|maps launcher|launch\w* maps|launch\w* directions|(?:available |find )?(?:installed maps|maps installed))\b/);
  }
  if (/\b(?:store redirect|app store page|app page|launch store|open store)\b/.test(normalized) && launch) {
    add("General", "storeLauncher", /\b(?:launch\w*|open\w*|redirect\w*)\b.{0,90}\b(?:store|app page)\b/);
  }
  if (/\b(?:external app launcher|open another app|open other apps|launch external apps|launch installed apps|app launcher|application launcher)\b/.test(normalized)) {
    add("General", "appLauncher", /\b(?:external app launcher|open another app|open other apps|launch external apps|launch installed apps|app launcher|application launcher)\b/);
  }
  if ((genericShare || !providers.length) && /\b(?:social|apps|applications|platform)\b/.test(normalized) && /\b(?:share|sharing)\b/.test(normalized)) {
    add("General", "shareText", /\b(?:share|sharing)\b.{0,90}\b(?:text|messages?|links?|urls?)\b/);
  }
  if (genericShare && /\b(?:files?|images?|videos?)\b/.test(normalized)) add("General","shareFiles",/\b(?:shar\w*|send\w*)\b.{0,90}\b(?:files?|images?|videos?)\b/);
  // Builders can compete for an outbound action without launching it directly.
  if (!genericShare && providers.length && /\b(?:build\w*|creat\w*|generat\w*|interact)\b/.test(normalized) && /\b(?:http links|links|uri|url)\b/.test(normalized)) {
    for (const provider of providers) add(provider, "buildUrl", /\b(?:build\w*|creat\w*|generat\w*|interact)\b/, "buildUrl", ["Pure-Dart/URI-only use and input normalization need separate assessment; DeeplinkX is a Flutter package."], /\b(?:links?|uri|url)\b/);
  }
  // A package-owned generic external URL operation is relevant, but cannot
  // establish compatibility with any particular provider action.
  add("General", "openUrl", /\b(?:open\w*|launch\w*)\b.{0,60}\b(?:external urls?|external links?|urls? in (?:an? |the )?(?:external |default )?browser)\b/);
  if (!providers.length) {
    add("General", "buildUrl", /\b(?:build\w*|creat\w*|generat\w*)\b.{0,60}\b(?:deep|universal|app) links?\b|\b(?:deep|universal|app) links? build\w*\b/, "buildUrl", ["Generic outbound link construction requires review against specific app URLs and runtime requirements."], /\b(?:external|other|another) (?:apps?|applications?)\b/);
  }
  const unique = [...new Map(matches.map((match) => [`${match.provider}:${match.action}`, match])).values()];
  const direct = unique.some((match) => match.deeplinkx_apis.length || ["mapLauncher", "storeLauncher", "appLauncher"].includes(match.action));
  const relevant = unique.length > 0;
  const adjacent = inbound || /\b(?:url launcher|launching a url|app availability|installed apps|dynamic links?|deferred links?|deep links?|deeplink)\b/.test(normalized);
  const relationship = direct ? "direct" : relevant || (!pureNoise && !backend && !embeddedMap && adjacent) ? "adjacent" : pureNoise || noise || backend || embeddedMap ? "noise" : "unknown";
  const category = unique.some((m) => m.action === "mapLauncher") ? "map/navigation launcher"
    : unique.some((m) => m.action === "storeLauncher") ? "store redirect and fallback"
    : unique.some((m) => m.action === "appLauncher") ? "external app launcher"
    : unique.some((m) => m.action === "openUrl") ? "general URL launcher"
    : relevant ? "provider-specific app linking" : inbound ? "inbound links/routing"
    : /url launcher|launching a url/.test(normalized) ? "general URL launcher" : adjacent ? "deep links" : "other";
  return {
    relationship, capability_category: category,
    rationale: relevant ? `Published evidence describes ${unique.map((m) => `${m.provider}: ${m.action}`).join(", ")}.`
      : relationship === "noise" ? "Published metadata describes functionality outside external-app actions."
      : inbound ? "Published evidence describes receiving or handling links into an application."
      : adjacent ? "Published evidence describes related linking or availability infrastructure."
      : "Available evidence does not establish an external-app capability; review required.",
    capabilities: unique, providers: [...new Set(unique.map((m) => m.provider))], actions: [...new Set(unique.map((m) => m.action))],
    migration_status: direct ? "partial" : relevant ? "unsupported" : "needs_review",
    expansion: unique.some((m) => !m.deeplinkx_apis.length && !["mapLauncher", "storeLauncher", "appLauncher"].includes(m.action)),
    review_status: relevant || relationship === "noise" || adjacent ? "rule_matched" : "needs_review",
  };
}

/** Extract only the published README, excluding dependency lists and sidebar search noise. */
export function readmeText(html: string): string {
  const start = html.search(/<(?:section|div)[^>]*class="[^"]*(?:detail-tab-readme|markdown-body)[^"]*"/i);
  if (start < 0) throw new Error("Published README container was not found.");
  const section = html.slice(html.indexOf(">", start) + 1).split(/<\/section>/i)[0];
  return section.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(?:p|li|h[1-6]|pre|div)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (entity) => ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[entity] ?? " ")
    .replace(/[ \t]+/g, " ").slice(0, 16000).trim();
}
