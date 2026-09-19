import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProductCapability } from "../src/shared/intelligence.js";

// Public API names are deliberately mapped, not guessed. A new unmapped action
// fails generation, making capability/query coverage a release check.
export const ACTION_PHRASES: Record<string, string[]> = {
  open: ["open", "launch"], view: ["map", "view map"],
  chat: ["chat", "open chat", "chat phone number"], shareText: ["share", "share text"],
  directions: ["directions", "directions by text"], directionsWithCoords: ["directions coordinates", "directions with coordinates"],
  search: ["search"], nearbySearch: ["nearby search"], busSearch: ["bus search"],
  navigate: ["navigation", "navigate"], safeDriving: ["safe driving"], directTo: ["direct to", "navigation coordinates"],
  myLocation: ["my location"], line: ["transit line", "open transit line"],
  organization: ["organization", "open organization"], whatIsHere: ["what is here"], panorama: ["panorama", "open panorama"],
  openMap: ["map", "open map"], openAppPage: ["app page", "open app page"], rateApp: ["review", "open review", "rate app"],
  openProfile: ["profile", "open profile"], openProfileById: ["profile id", "open profile by id", "profile"],
  openProfileByUsername: ["profile username", "open profile by username", "open profile"],
  openProfileByPhoneNumber: ["profile phone number", "open profile by phone number"],
  sendMessage: ["message", "send message"], sendMessageByPhoneNumber: ["message phone number", "send message by phone number"],
  openSharedConversation: ["conversation", "open shared conversation"], openGpt: ["gpt", "open gpt"],
  watchTitle: ["watch title"], joinMeeting: ["meeting", "join meeting"], createPost: ["create post"],
};
for (const noun of ["board", "channel", "comments", "company", "event", "group", "link", "page", "pin", "playlist", "post", "tag", "team", "template", "title", "tweet", "user", "video"]) {
  ACTION_PHRASES[`open${noun[0].toUpperCase()}${noun.slice(1)}`] = [noun, `open ${noun}`];
}

export async function inventoryForDoc(root: string, doc: { name: string; location: string; isStore: boolean }): Promise<ProductCapability[]> {
  const basename = path.basename(doc.location, ".md") === "2gis" ? "two_gis" : path.basename(doc.location, ".md");
  const source = `lib/src/apps/${doc.isStore ? "app_stores" : "downloadable_apps"}/${basename}.dart`;
  const code = await fs.readFile(path.join(root, source), "utf8");
  const className = code.match(/^class\s+(\w+)/m)?.[1];
  if (!className) throw new Error(`No provider class in ${source}`);
  const methods = [...code.matchAll(/^\s*static\s+[\w<>?]+\s+(\w+)\s*\(/gm)].map((match) => match[1]);
  if (code.includes(`factory ${className}.open(`)) methods.unshift("open");
  if (!methods.length) throw new Error(`No public actions in ${source}`);
  const platformsBody = code.match(/get supportedPlatforms\s*=>\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  const platforms = [...new Set([...platformsBody.matchAll(/PlatformType\.(\w+)/g)].map((match) => match[1]))];
  const documentation = await fs.readFile(path.join(root, doc.location), "utf8");
  return [...new Set(methods)].map((action) => {
    const phrases = ACTION_PHRASES[action];
    if (!phrases) throw new Error(`Unmapped public action ${className}.${action} in ${source}`);
    const api = `${className}.${action}`;
    return {
      id: `${className}.${action}`, provider: doc.name, kind: doc.isStore ? "store" : "app", action, api,
      phrases, platforms, source, documentation: doc.location, query_ids: [],
      documentation_warnings: documentation.includes(`${api}(`) ? [] : [`${api} has no matching documentation example; the public declaration is authoritative.`],
    };
  });
}

export async function validateProviderCoverage(root: string, capabilities: ProductCapability[]): Promise<void> {
  const covered = new Set(capabilities.map((capability) => capability.source));
  for (const directory of ["downloadable_apps", "app_stores"]) {
    const relative = `lib/src/apps/${directory}`;
    for (const filename of await fs.readdir(path.join(root, relative))) {
      if (!filename.endsWith(".dart")) continue;
      const source = `${relative}/${filename}`;
      const code = await fs.readFile(path.join(root, source), "utf8");
      if (/^class\s+\w+/m.test(code) && !covered.has(source)) {
        throw new Error(`Provider has no documentation/action coverage: ${source}`);
      }
    }
  }
}
