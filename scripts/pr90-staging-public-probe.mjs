/** Public, non-mutating checks against a separately provisioned staging Worker. */
import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
const origin=(process.env.PR90_STAGING_ORIGIN||"").replace(/\/$/,"");
const name=process.env.PR90_WORKER_NAME||"";
if(!/^gs-poster-pr90-[a-z0-9-]{3,35}$/.test(name))throw Error("Missing permitted PR90 Worker name.");
const parsed=new URL(origin);
if(parsed.protocol!=="https:" || parsed.hostname!==name+"."+parsed.hostname.split(".").slice(1).join(".") ||
   !parsed.hostname.endsWith(".workers.dev") || parsed.hostname==="gs-poster.goofyspook.workers.dev")
  throw Error("Public probe refused: origin is not this isolated PR90 workers.dev hostname.");
const results=[];
async function probe(path,method,expected,body){
  const response=await fetch(origin+path,{method,body,redirect:"manual",signal:AbortSignal.timeout(20000)});
  const item={path,method,status:response.status,expected,nonpublishing:response.headers.get("x-gs-staging-no-publish")==="1"};
  results.push(item);
  assert.equal(response.status,expected,method+" "+path);
  assert.equal(item.nonpublishing,true,"missing staging no-publish marker");
}
await probe("/health","GET",200);
await probe("/mcp","GET",403);
await probe("/post/p_isolated/approve","POST",403,"");
await probe("/post/p_isolated/retry-facebook","POST",403,"");
await probe("/post/p_isolated/tiktok-send","POST",403,"");
await probe("/post/p_isolated/instagram-retry","POST",403,"");
await probe("/","GET",302);
await mkdir("artifacts/pr90-staging",{recursive:true});
const evidence={commit:process.env.GITHUB_SHA||"unknown",worker:name,at:new Date().toISOString(),
  checks:results,remaining:"live 40/49 MB upload, readback and quota evidence, memory telemetry, browser tests"};
await writeFile("artifacts/pr90-staging/public-probe.json",JSON.stringify(evidence,null,2)+"\n");
console.log("PASS: isolated public staging boundary checks. No publishing request was accepted.");
