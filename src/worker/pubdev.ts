/** Shared by the single Queue consumer: one throttle response pauses all pub.dev work. */
export class PubdevDeferredError extends Error {
  constructor(readonly delaySeconds: number) { super("Waiting for pub.dev's shared cooldown."); }
}

interface Gate { not_before: number; next_request: number; }
async function gate(env: Env): Promise<Gate> {
  const row = await env.DB.prepare("SELECT value_json FROM system_state WHERE key='pubdev_request_gate'").first<{value_json:string}>();
  return row ? JSON.parse(row.value_json) as Gate : {not_before:0,next_request:0};
}
async function save(env: Env, value: Gate): Promise<void> {
  await env.DB.prepare("INSERT INTO system_state(key,value_json,updated_at) VALUES('pubdev_request_gate',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
    .bind(JSON.stringify(value),new Date().toISOString()).run();
}
export async function beforePubdevRequest(env: Env): Promise<void> {
  const value = await gate(env);
  if (value.not_before > Date.now()) throw new PubdevDeferredError(Math.min(43200,Math.max(1,Math.ceil((value.not_before-Date.now())/1000))));
  const spacing = Math.min(2000,Math.max(0,value.next_request-Date.now()));
  if (spacing) await new Promise((resolve)=>setTimeout(resolve,spacing));
  await save(env,{not_before:0,next_request:Date.now()+2000});
}
export async function recordPubdevThrottle(env: Env, retrySeconds: number): Promise<void> {
  const value = await gate(env);
  await save(env,{...value,not_before:Math.max(value.not_before,Date.now()+Math.max(60,retrySeconds)*1000)});
}
