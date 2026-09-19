import { promises as fs } from "node:fs";
import path from "node:path";

const base="https://deeplinkx-visibility.parham-dev.workers.dev";
const [command,...args]=process.argv.slice(2);
const token=process.env.DEEPLINKX_VISIBILITY_ADMIN_TOKEN;
if (!token) throw new Error("DEEPLINKX_VISIBILITY_ADMIN_TOKEN must be set without placing it on the command line.");
let route:string;let body:unknown;
if(command==="export") {route="review/export";body={packages:args};}
else if(command==="import") {
  if(!args[0]) throw new Error("import requires a reviewed JSON file outside the repository.");
  const filename=path.resolve(args[0]);
  if(filename.startsWith(`${process.cwd()}${path.sep}`)) throw new Error("Review packets belong outside the repository.");
  route="review/import";body=JSON.parse(await fs.readFile(filename,"utf8"));
} else if(command==="refresh") {route="refresh";body={full:args.includes("--full")};}
else throw new Error("Usage: competitors export package... | import /outside/repo/review.json | refresh [--full]");
const response=await fetch(`${base}/api/v1/admin/competitors/${route}`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json","idempotency-key":`competitors:${command}:${crypto.randomUUID()}`},body:JSON.stringify(body)});
const result=await response.text();
if(!response.ok) throw new Error(`HTTP ${response.status}: ${result}`);
process.stdout.write(`${JSON.stringify(JSON.parse(result),null,2)}\n`);
