/**
 * Operator-run end-to-end Cloudflare staging test for GitHub-linked MP4 import.
 * Create an UNAPPROVED staging draft referencing an allowlisted GSGrimoire/Images
 * GitHub MP4. Supply a staging-only signed-in session cookie through the
 * environment, never through arguments or logs.
 * Usage: node scripts/pr90-staging-private-video.mjs p_POSTID tiktok /path/source.mp4
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {open,mkdir,stat,writeFile} from "node:fs/promises";
const [id,target,file]=process.argv.slice(2);
if(!/^p_[a-z0-9]+$/.test(id||"") || !["tiktok","bluesky","instagram"].includes(target) || !file)
  throw Error("Provide a staging draft ID, a tiktok/bluesky/instagram target and source MP4 path.");
const origin=(process.env.PR90_STAGING_ORIGIN||"").replace(/\/$/,"");
const url=new URL(origin);
if(url.protocol!=="https:" || !/^gs-poster-pr90-[a-z0-9-]{3,35}\.[^.]+\.workers\.dev$/.test(url.hostname))
  throw Error("Refusing to run outside a PR90 isolated staging Worker.");
const cookie=process.env.PR90_SESSION_COOKIE||"";
if(!/^__Host-gsp_session=[A-Za-z0-9_.-]+$/.test(cookie))
  throw Error("Set PR90_SESSION_COOKIE to the single staging session cookie, not production.");
const size=(await stat(file)).size;
if(![40_000_000,49_000_000].includes(size))
  throw Error("Use a real 40,000,000 or 49,000,000-byte MP4.");
const fd=await open(file,"r");
try{
  const header=Buffer.alloc(12);
  await fd.read(header,0,12,0);
  if(header.subarray(4,8).toString("ascii")!=="ftyp")throw Error("File lacks an MP4 ftyp header.");
}finally{await fd.close();}
const hash=createHash("sha256");
for await(const chunk of createReadStream(file))hash.update(chunk);
const sourceSha=hash.digest("hex");
const headers={Cookie:cookie,"Cache-Control":"no-store"};
const page=await fetch(origin+"/post/"+id,{headers,redirect:"manual",signal:AbortSignal.timeout(20000)});
assert.equal(page.status,200,"Login failed or draft inaccessible on isolated staging.");
const html=await page.text();
function hidden(name){
  const re=new RegExp('<input[^>]*name="'+name+'"[^>]*value="([^"]+)"');
  const found=html.match(re)?.[1];
  if(!found)throw Error("Draft review form does not expose "+name);
  return found.replaceAll("&amp;","&");
}
const csrf=hidden("csrf"),version=hidden("expected_updated_at");
const started=new Date().toISOString();
const imported=await fetch(origin+"/post/"+id+"/import-video",{method:"POST",headers:{
  Cookie:cookie,Origin:origin,"Sec-Fetch-Site":"same-origin",
  "Content-Type":"application/json",Accept:"application/json"},
  body:JSON.stringify({csrf,expected_updated_at:version,target}),redirect:"manual",
  signal:AbortSignal.timeout(180000)});
const output=await imported.json().catch(()=>({}));
assert.equal(imported.status,200,"GitHub video import failed (HTTP "+imported.status+").");
assert.equal(output.ok,true,"GitHub import did not confirm success.");
assert.match(output.reference||"",/^upload:\/\/[a-f0-9]{32}\.mp4$/);
const prefixSize=1048576;
const range=await fetch(origin+"/video/"+id+"/"+target,{headers:{...headers,Range:"bytes=0-"+(prefixSize-1)},
  redirect:"manual",signal:AbortSignal.timeout(180000)});
assert.equal(range.status,206,"Signed-in private video range preview failed.");
assert.equal(range.headers.get("content-range"),"bytes 0-"+(prefixSize-1)+"/"+size);
const prefix=new Uint8Array(await range.arrayBuffer());
assert.equal(prefix.length,prefixSize);
const whole=await fetch(origin+"/video/"+id+"/"+target,{headers,redirect:"manual",
  signal:AbortSignal.timeout(180000)});
assert.equal(whole.status,200,"Private downstream preview failed.");
const digest=createHash("sha256");
let received=0;
for await(const chunk of whole.body){
  received+=chunk.length;
  digest.update(chunk);
}
assert.equal(received,size,"The private downstream video was truncated.");
assert.equal(digest.digest("hex"),sourceSha,"Private downstream video differs from the original.");
const info={scenario:"pr90-real-Cloudflare-GitHub-import-and-downstream-preview",
  postId:id,target,bytes:size,sourceSha256:sourceSha,storedReference:output.reference,
  importedAt:started,finishedAt:new Date().toISOString(),importStatus:imported.status,
  rangeStatus:range.status,rangeLength:prefix.length,fullPreviewStatus:whole.status,fullPreviewBytes:received,
  endpointHost:url.hostname,commit:process.env.GITHUB_SHA||"operator-local",
  remaining:["Independent R2 metadata/part hashes","D1 owner/quota state","Cloudflare exceededMemory/1102/5xx chart",
    "Browser interaction evidence","Independent final review"]};
await mkdir("artifacts/pr90-staging",{recursive:true});
const path="artifacts/pr90-staging/github-import-"+target+"-"+size+".json";
await writeFile(path,JSON.stringify(info,null,2)+"\n",{mode:0o600});
console.log("PASS: staged GitHub conversion, one-megabyte range and full downstream digest "+size+". Evidence: "+path);
console.log("No approval or social-media publication was requested.");
