import {applyD1Migrations,env} from "cloudflare:test";
import {beforeAll,describe,it,expect} from "vitest";
import {beforePubdevRequest,recordPubdevThrottle,PubdevDeferredError} from "../src/worker/pubdev.js";
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
describe("shared pub.dev scheduling",()=>{
 it("persists Retry-After across requests and never shortens a longer cooldown",async()=>{
  await recordPubdevThrottle(env,180);
  await expect(beforePubdevRequest(env)).rejects.toBeInstanceOf(PubdevDeferredError);
  await recordPubdevThrottle(env,2);
  await expect(beforePubdevRequest(env)).rejects.toMatchObject({delaySeconds:expect.any(Number)});
  const row=await env.DB.prepare("SELECT value_json FROM system_state WHERE key='pubdev_request_gate'").first<{value_json:string}>();
  expect(JSON.parse(row!.value_json).not_before-Date.now()).toBeGreaterThan(175000);
 });
 it("resumes after expiry and records spacing for the next request",async()=>{
  await env.DB.prepare("UPDATE system_state SET value_json=? WHERE key='pubdev_request_gate'").bind(JSON.stringify({not_before:Date.now()-1,next_request:0})).run();
  await beforePubdevRequest(env);
  const row=await env.DB.prepare("SELECT value_json FROM system_state WHERE key='pubdev_request_gate'").first<{value_json:string}>();
  expect(JSON.parse(row!.value_json)).toMatchObject({not_before:0});
  expect(JSON.parse(row!.value_json).next_request-Date.now()).toBeGreaterThan(1500);
 });
 it("preserves an upstream cooldown longer than the Queue delay limit",async()=>{
  await recordPubdevThrottle(env,43200,new Response(null,{headers:{"retry-after":"86400"}}));
  await expect(beforePubdevRequest(env)).rejects.toMatchObject({delaySeconds:43200});
  const row=await env.DB.prepare("SELECT value_json FROM system_state WHERE key='pubdev_request_gate'").first<{value_json:string}>();
  expect(JSON.parse(row!.value_json).not_before-Date.now()).toBeGreaterThan(86395000);
 });
});
