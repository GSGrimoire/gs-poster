/** GitHub-only image downloader: protect read tokens and bound remote media. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {fetchImage,parseGitHubUrl,MAX_IMAGE_BYTES} from "../src/media.ts";
import {fetchVideo} from "../src/video.ts";
import type {Env} from "../src/env.ts";

const LINK="https://github.com/GSGrimoire/Assets/blob/main/leaf.png";
const RAW="https://raw.githubusercontent.com/GSGrimoire/Assets/main/leaf.png";
const API="https://api.github.com/repos/GSGrimoire/Assets/contents/leaf.png?ref=main";
const TOKEN="image-read-token-TEST-DO-NOT-USE";
const png=new Uint8Array([137,80,78,71,13,10,26,10,1,2]);
const env={GITHUB_READ_TOKEN:TOKEN,GITHUB_READ_REPOS:" gsgrimoire/assets , gsgrimoire/other-approved "} as Env;
function reply(bytes=png,extra:HeadersInit={}):Response {
  return new Response(bytes,{status:200,headers:extra});
}
async function withFetch<T>(mock:(req:Request)=>Promise<Response>|Response,run:()=>Promise<T>):Promise<T> {
  const original=globalThis.fetch;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    return mock(new Request(input,init));
  }) as typeof fetch;
  try{return await run();}finally{globalThis.fetch=original;}
}
test("GitHub URL inputs cannot select a non-GitHub network host",()=>{
  assert.equal(parseGitHubUrl("https://evil.example/GSGrimoire/Assets/main/leaf.png"),null);
  assert.equal(parseGitHubUrl("http://raw.githubusercontent.com/GSGrimoire/Assets/main/leaf.png"),null);
  assert.equal(parseGitHubUrl("https://raw.githubusercontent.com.evil.example/a/b/main/x.png"),null);
  assert.equal(parseGitHubUrl("https://github.com.evil.example/a/b/blob/main/x.png"),null);
  assert.deepEqual(parseGitHubUrl(LINK),{owner:"GSGrimoire",repo:"Assets",ref:"main",path:"leaf.png"});
});

test("GitHub media parsing keeps repository names and file segments canonical",()=>{
  assert.equal(parseGitHubUrl("https://github.com/Template/Two%2FNames/blob/main/leaf.png"),null);
  assert.equal(parseGitHubUrl("https://github.com/Template/Assets/blob/main/Fall%2FWinter.png"),null);
  assert.equal(parseGitHubUrl("https://github.com/Template/Assets/blob/main/invalid%00leaf.png"),null);
  assert.deepEqual(parseGitHubUrl("https://github.com/Template/Assets/blob/feature%2Fposter/Album/Blue%20leaf.png"),
    {owner:"Template",repo:"Assets",ref:"feature/poster",path:"Album/Blue leaf.png"});
});

test("public image fetch requests a fixed raw host with manual redirects and no token",async()=>{
  const seen:Request[]=[];
  await withFetch(req=>{seen.push(req);return reply();},async()=>{
    const result=await fetchImage(env,LINK);
    assert.deepEqual([...new Uint8Array(result.bytes)],[...png]);
    assert.equal(result.type,"image/png");
  });
  assert.deepEqual(seen.map(x=>x.url),[RAW]);
  assert.equal(seen[0].redirect,"manual");
  assert.equal(seen[0].headers.get("authorization"),null);
});

test("public redirect is not followed; private fallback only sends token to api.github.com",async()=>{
  const seen:Request[]=[];
  await withFetch(req=>{
    seen.push(req);
    if(req.url===RAW)return new Response(null,{status:302,
      headers:{Location:"https://untrusted.example/steal?redirect=1"}});
    assert.equal(req.url,API);
    return reply();
  },async()=>{
    const result=await fetchImage(env,LINK);
    assert.equal(result.bytes.byteLength,png.length);
  });
  assert.deepEqual(seen.map(x=>x.url),[RAW,API]);
  assert.equal(seen[0].headers.get("Authorization"),null);
  assert.equal(seen[1].headers.get("Authorization"),"Bearer "+TOKEN);
  assert.equal(seen[1].redirect,"manual");
});

test("authenticated 30x is rejected without following or forwarding GitHub credentials",async()=>{
  const seen:Request[]=[];
  await withFetch(req=>{
    seen.push(req);
    if(req.url===RAW)return new Response(null,{status:404});
    if(req.url===API)return new Response(null,{status:302,
      headers:{Location:"https://untrusted.example/steal"}});
    throw Error("Unexpected external request: "+req.url);
  },async()=>{
    await assert.rejects(fetchImage(env,LINK),/Could not fetch/);
  });
  assert.deepEqual(seen.map(x=>x.url),[RAW,API]);
  assert.equal(seen[1].redirect,"manual");
});

test("streamed image limit enforced without content-length on authenticated fallback",async()=>{
  const seen:Request[]=[];
  await withFetch(req=>{
    seen.push(req);
    if(req.url===RAW)return new Response(null,{status:404});
    const chunks=[new Uint8Array(MAX_IMAGE_BYTES),new Uint8Array(1)];
    return new Response(new ReadableStream({pull(c){c.enqueue(chunks.shift()!);if(!chunks.length)c.close();}}));
  },async()=>{
    await assert.rejects(fetchImage(env,LINK),/over 10 MB/);
  });
  assert.deepEqual(seen.map(x=>x.url),[RAW,API]);
});

test("an unapproved repository can serve public media and cannot receive the read token",async()=>{
  const seen:Request[]=[];
  let available=true;
  const link="https://github.com/GSGrimoire/PublicAssets/blob/main/leaf.png";
  const raw="https://raw.githubusercontent.com/GSGrimoire/PublicAssets/main/leaf.png";
  await withFetch(req=>{seen.push(req);return available?reply():new Response(null,{status:404});},async()=>{
    assert.equal((await fetchImage(env,link)).bytes.byteLength,png.length);
    available=false;
    await assert.rejects(fetchImage(env,link),/configured repository/);
    await assert.rejects(fetchVideo(env,link.replace("leaf.png","leaf.mp4")),/configured repository/);
  });
  assert.deepEqual(seen.map(req=>req.url),[raw,raw,raw.replace("leaf.png","leaf.mp4")]);
  assert.ok(seen.every(req=>!req.headers.has("Authorization")));
});

test("the configured staging repository permits an authenticated video read",async()=>{
  const staging={GITHUB_STAGING_REPO:"gsgrimoire/assets",GITHUB_READ_TOKEN:TOKEN} as Env;
  const mp4=new Uint8Array([0,0,0,12,102,116,121,112,105,115,111,109]);
  const seen:Request[]=[];
  await withFetch(req=>{
    seen.push(req);
    return req.url===RAW.replace("leaf.png","leaf.mp4")?new Response(null,{status:404}):reply(mp4);
  },async()=>{
    assert.deepEqual(await fetchVideo(staging,LINK.replace("leaf.png","leaf.mp4")),mp4);
  });
  assert.deepEqual(seen.map(req=>req.url),[RAW,API].map(url=>url.replace("leaf.png","leaf.mp4")));
  assert.equal(seen[0].headers.get("Authorization"),null);
  assert.equal(seen[1].headers.get("Authorization"),"Bearer "+TOKEN);
  assert.equal(seen[1].redirect,"manual");
});
