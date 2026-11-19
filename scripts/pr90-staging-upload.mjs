/**
 * Live staged one-time public PUT acceptance.
 *
 * Run locally against a separately provisioned, publication-disabled Worker.
 * PR90_UPLOAD_URL is a fresh secret bearer grant (10-minute validity), NEVER
 * a command-line argument or printed value. Use a real MP4 file on disk.
 *
 * Example:
 *   PR90_STAGING_ORIGIN=https://gs-poster-pr90-acceptance.SUBDOMAIN.workers.dev \\
 *   PR90_UPLOAD_URL='(temporary secret from staging UI)' \\
 *   node scripts/pr90-staging-upload.mjs /path/to/40mb-real.mp4
 */
import assert from "node:assert/strict";
import {createReadStream} from "node:fs";
import {open,stat,mkdir,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
const path=process.argv[2];
if(!path)throw Error("Supply the path to a real 40,000,000 or 49,000,000-byte MP4 file.");
const size=(await stat(path)).size;
if(size!==40_000_000 && size!==49_000_000)
  throw Error("Acceptance source must contain exactly 40,000,000 or 49,000,000 bytes.");
const source=await open(path,"r");
try {
  const signature=Buffer.alloc(12);
  await source.read(signature,0,12,0);
  if(signature.subarray(4,8).toString("ascii")!=="ftyp")
    throw Error("Input is not an MP4 with a recognized ftyp header.");
} finally {await source.close();}
const stage=(process.env.PR90_STAGING_ORIGIN||"").replace(/\/$/,"");
const grant=process.env.PR90_UPLOAD_URL||"";
const origin=new URL(stage),url=new URL(grant);
if(origin.protocol!=="https:" || !/^gs-poster-pr90-[a-z0-9-]{3,35}\.[^.]+\.workers\.dev$/.test(origin.hostname) ||
   url.origin!==origin.origin || !/^\/upload\/[a-f0-9]{32}\/[A-Za-z0-9_-]{20,64}$/.test(url.pathname))
  throw Error("Refusing to send video: secret grant is not on an isolated PR90 staging Worker.");
const hash=createHash("sha256");
for await(const chunk of createReadStream(path))hash.update(chunk);
const sha256=hash.digest("hex");
const started=new Date().toISOString();
const response=await fetch(url,{method:"PUT",body:createReadStream(path),duplex:"half",
  redirect:"manual",headers:{"Content-Length":String(size),"Content-Type":"video/mp4"},
  signal:AbortSignal.timeout(120000)});
const result=await response.json().catch(()=>({}));
assert.equal(response.status,200,"Staged upload failed with status "+response.status);
assert.equal(result?.ok,true);
assert.equal(result?.bytes,size,"Cloudflare reported a different stored byte count");
assert.match(result.reference||"",/^upload:\/\/[a-f0-9]{32}\.mp4$/);
const replay=await fetch(url,{method:"PUT",body:Buffer.from([0,0,0,12,102,116,121,112,105,115,111,109]),
  redirect:"manual",headers:{"Content-Length":"12","Content-Type":"video/mp4"},
  signal:AbortSignal.timeout(20000)});
assert.equal(replay.status,404,"A completed staging one-time grant must refuse replay");
const evidence={scenario:"pr90-real-Cloudflare-public-PUT",sourceBytes:size,sourceSha256:sha256,
  startedAt:started,finishedAt:new Date().toISOString(),httpStatus:response.status,
  storedBytes:result.bytes,reference:result.reference,replayStatus:replay.status,
  endpointHost:origin.hostname,commit:process.env.GITHUB_SHA||"operator-local",
  notYetVerified:["R2 independent object metadata and ranged digest readback","Owner isolation",
    "D1 quota arithmetic","Cloudflare memory, 1102, exceededMemory and 5xx telemetry",
    "GitHub import flow, downstream 40-49 MB video consumers"]};
await mkdir("artifacts/pr90-staging",{recursive:true});
const out="artifacts/pr90-staging/public-put-"+size+".json";
await writeFile(out,JSON.stringify(evidence,null,2)+"\n",{mode:0o600});
console.log("PASS: live Cloudflare public PUT "+size+" bytes and denied replay. Evidence: "+out);
console.log("The R2 digest, memory telemetry and private downstream checks still require separate evidence.");
