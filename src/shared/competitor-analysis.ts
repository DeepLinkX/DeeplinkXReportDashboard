import { semanticText } from "./catalog.js";
import type { CapabilityMatch, PackageAnalysis, ProductCapability } from "./intelligence.js";

export const ANALYSIS_VERSION = "capabilities-v2.2";

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
  const chunks = [input.description, ...(input.documentation ?? "").split(/\n|(?<=[.!?])\s+/)]
    .map((line) => line.trim()).filter(Boolean);
  const providers = [...new Set(inventory.map((item) => item.provider))].filter((provider) => contains(text, provider));
  const matches: CapabilityMatch[] = [];
  const genericShare = /platform share (ui|dialog)|system share sheet|native share dialog/.test(metaText(metadata));
  const noise = /\b(?:icon(?:s|ify)?|font(?:s)?|ui kit|chat bubbles|state management|database|logger|logging)\b/.test(meta);
  const pureNoise = /\b(?:icon pack|icons pack|icon set|icons set|iconify|font icons|brand icons|launcher icon|dynamic icon|chat bubbles|state management|database|logging)\b/.test(meta);
  const backend = /\b(?:cloud api|business api|rest api|web services?|webservices|directions api|place apis|chatbot|chat bot|bot api|authentication|otp verification)\b/.test(meta);
  const embeddedMap = /\b(?:vector map|map control|map widgets?|maps? sdk|map snapshots?|static apple maps snapshots|drawing routes|map previews)\b/.test(meta)
    && !/\b(?:launch\w*|external|installed maps|maps installed)\b/.test(meta);
  const launch = /\b(?:launch(?:es|ing)?|open(?:s|ing)?|redirect(?:s|ing)?)\b/.test(normalized);
  const outbound = /\b(?:share|sharing|send|sending|chat|interact|build|building|create|creating|generate|generating)\b/.test(normalized);
  const inbound = /\b(?:receiv(?:e|es|ing)|incoming|inbound|handl(?:e|er|es|ing)|routing|router)\b/.test(normalized)
    && /\b(?:links?|url|uri|schemes?)\b/.test(normalized);

  function add(provider: string, action: string, expression: RegExp, apiAction?: string, extra: string[] = [], requires?: RegExp) {
    const qualifies = (chunk: string) => expression.test(semanticText(chunk)) && (!requires || requires.test(semanticText(chunk)));
    const evidence = chunks.find((chunk) => qualifies(chunk) && (provider === "General" || contains(chunk, provider)))
      ?? (providers.length === 1 && providers[0] === provider ? chunks.find(qualifies) : undefined);
    if (!evidence) return;
    const apis = inventory.filter((capability) => capability.provider === provider && capability.action === (apiAction ?? action));
    matches.push({ provider, action, evidence: evidence.slice(0, 600),
      source_url: input.description.includes(evidence) ? input.source_url : input.documentation_url ?? input.source_url,
      deeplinkx_apis: apis.map((capability) => capability.api),
      migration: apis.length ? "partial" : "unsupported",
      caveats: ["Documentation establishes an overlap hypothesis; validate parameters, platform behavior, and fallback semantics before migrating.", ...extra],
    });
  }

  if (!pureNoise && !backend && !embeddedMap) {
    for (const provider of genericShare ? [] : providers) {
      const capabilities = inventory.filter((item) => item.provider === provider);
      if (launch) add(provider, "open", /\b(?:launch\w*|open\w*|redirect\w*)\b/);
      if (outbound) {
        if (/\b(?:shar\w*|send\w*)\b/.test(normalized) && /\b(?:text|message|links?|urls?)\b/.test(normalized)) {
          add(provider, "shareText", /\b(?:shar\w*|send\w*)\b/, capabilities.some((c) => c.action === "shareText") ? "shareText" : "sendMessage");
        }
        if (/\b(?:chat|phone number|click to chat)\b/.test(normalized)) add(provider, "chat", /\b(?:chat|phone number)\b/);
        if (/\b(?:shar\w*|send\w*)\b/.test(normalized) && /\b(?:files?|images?|videos?|media|stories|stickers?)\b/.test(normalized)) {
          add(provider, "shareFiles", /\b(?:files?|images?|videos?|media|stories|stickers?)\b/, "shareFiles", ["DeeplinkX text/URL actions do not establish native file, media, or story sharing support."], /\b(?:shar\w*|send\w*)\b/);
        }
      }
      for (const capability of capabilities.filter((c) => !["open", "shareText", "chat"].includes(c.action))) {
        const phrase = capability.phrases.find((value) => contains(normalized, value));
        if (!phrase || !(launch || outbound || /\b(?:directions|navigation|map launcher)\b/.test(normalized))) continue;
        add(provider, capability.action, new RegExp(`\\b${semanticText(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`), undefined, [], /\b(?:launch\w*|open\w*|show\w*|view\w*|search\w*|navigat\w*|directions|send\w*|creat\w*|join\w*|watch\w*|rate\w*)\b/);
      }
    }
    if (/\b(?:map launcher|maps launcher|launch maps|available maps installed|maps installed)\b/.test(normalized)) {
      add("General", "mapLauncher", /\b(?:maps?|directions)\b/);
    }
    if (/\b(?:store redirect|app store page|app page|launch store|open store)\b/.test(normalized) && launch) {
      add("General", "storeLauncher", /\b(?:store|app page)\b/);
    }
    if (!providers.length && /\b(?:external app launcher|open another app|open other apps|launch external apps|launch installed apps|app launcher|application launcher)\b/.test(normalized)) {
      add("General", "appLauncher", /\b(?:launch\w*|open\w*)\b/);
    }
    if ((genericShare || !providers.length) && /\b(?:social|apps|applications|platform)\b/.test(normalized) && /\b(?:share|sharing)\b/.test(normalized)) {
      add("General", "shareText", /\b(?:share|sharing)\b/);
    }
    if (genericShare && /\b(?:files?|images?|videos?)\b/.test(normalized)) add("General","shareFiles",/\b(?:files?|images?|videos?)\b/);
    // Builders can compete for an outbound action without launching it directly.
    if (!genericShare && providers.length && /\b(?:build\w*|creat\w*|generat\w*|interact)\b/.test(normalized) && /\b(?:http links|links|uri|url)\b/.test(normalized)) {
      for (const provider of providers) add(provider, "buildUrl", /\b(?:build\w*|creat\w*|generat\w*|interact)\b/, "buildUrl", ["Pure-Dart/URI-only use and input normalization need separate assessment; DeeplinkX is a Flutter package."], /\b(?:links?|uri|url)\b/);
    }
  }
  const unique = [...new Map(matches.map((match) => [`${match.provider}:${match.action}`, match])).values()];
  const direct = unique.some((match) => match.deeplinkx_apis.length || ["mapLauncher", "storeLauncher", "appLauncher"].includes(match.action));
  const relevant = unique.length > 0;
  const adjacent = inbound || /\b(?:url launcher|launching a url|app availability|installed apps|dynamic links?|deferred links?|deep links?|deeplink)\b/.test(normalized);
  const metadataFunctional = /launch|link|redirect|navigation|directions|interact|shar|send|availability|installed/.test(meta);
  const relationship = direct && metadataFunctional ? "direct" : relevant || (!pureNoise && !backend && !embeddedMap && adjacent) ? "adjacent" : pureNoise || noise || backend || embeddedMap ? "noise" : "unknown";
  const category = unique.some((m) => m.action === "mapLauncher") ? "map/navigation launcher"
    : unique.some((m) => m.action === "storeLauncher") ? "store redirect and fallback"
    : unique.some((m) => m.action === "appLauncher") ? "external app launcher"
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
    review_status: (relevant && metadataFunctional) || relationship === "noise" || adjacent ? "rule_matched" : "needs_review",
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
