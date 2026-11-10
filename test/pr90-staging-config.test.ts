import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const file=fileURLToPath(new URL("../scripts/pr90-staging-config.mjs",import.meta.url));
const baseEnv={
  ...process.env,
  PR90_WORKER_NAME:"gs-poster-pr90-acceptance",
  PR90_D1_DATABASE_ID:"12345678-1234-1234-1234-123456789abc",
  PR90_KV_NAMESPACE_ID:"0123456789abcdef0123456789abcdef",
  PR90_R2_BUCKET:"gs-poster-pr90-acceptance-media",
  PR90_LOGIN:"TestAccount",
  PR90_STAGING_CONFIRM:"ISOLATED_STAGING_NO_PUBLISH",
  GITHUB_ACTIONS:"true",
  GITHUB_HEAD_REF:"", // Do not inherit GitHub's PR env into branch-negative cases.
  GITHUB_REF:"refs/heads/feature/bluesky-gallery-redraft-video50-20261109",
};
function run(overrides:Record<string,string>={}){
  const cwd=mkdtempSync(join(tmpdir(),"pr90-config-"));
  const result=spawnSync(process.execPath,[file],{cwd,env:{...baseEnv,...overrides},encoding:"utf8"});
  return {cwd,result};
}

test("isolated staging config never contains production bindings or publishing triggers",()=>{
  const {cwd,result}=run();
  try{
    assert.equal(result.status,0,result.stderr);
    const c=JSON.parse(readFileSync(join(cwd,"wrangler.pr90-staging.generated.json"),"utf8"));
    assert.equal(c.name,"gs-poster-pr90-acceptance");
    assert.equal(c.main,"src/pr90-staging-entry.ts");
    assert.deepEqual(c.triggers.crons,[]);
    assert.equal(c.observability.enabled,true);
    assert.equal(c.vars.STAGING_NO_PUBLISH,"1");
    assert.equal(c.vars.ALLOWED_GITHUB_LOGINS,"TestAccount");
    assert.notEqual(c.r2_buckets[0].bucket_name,"gs-poster-uploads");
    assert.equal(c.d1_databases[0].database_id,baseEnv.PR90_D1_DATABASE_ID);
    assert.equal(c.kv_namespaces[0].id,baseEnv.PR90_KV_NAMESPACE_ID);
    assert.ok(!("images" in c),"no account-level Cloudflare Images shared with production");
    assert.ok(!JSON.stringify(c).includes("FB_PAGE_TOKEN"));
    assert.ok(!JSON.stringify(c).includes("TIKTOK_CLIENT_SECRET"));
  }finally{rmSync(cwd,{recursive:true,force:true});}
});

test("a premerge labelled pull request uses the reviewed head branch, not the synthetic merge ref",()=>{
  const allowed=run({GITHUB_REF:"refs/pull/90/merge",
    GITHUB_HEAD_REF:"feature/bluesky-gallery-redraft-video50-20261109"});
  try{assert.equal(allowed.result.status,0,allowed.result.stderr);}
  finally{rmSync(allowed.cwd,{recursive:true,force:true});}
  const wrong=run({GITHUB_REF:"refs/pull/90/merge",GITHUB_HEAD_REF:"main"});
  try{assert.notEqual(wrong.result.status,0);}
  finally{rmSync(wrong.cwd,{recursive:true,force:true});}
});

test("staging generation refuses production names, missing confirmation, wrong branch and invalid identifiers",()=>{
  const cases=[
    {PR90_WORKER_NAME:"gs-poster"},
    {PR90_R2_BUCKET:"gs-poster-uploads"},
    {PR90_STAGING_CONFIRM:""},
    {GITHUB_REF:"refs/heads/main"},
    {PR90_KV_NAMESPACE_ID:"invalid"},
    {PR90_D1_DATABASE_ID:"local-gs-poster-db"},
    {PR90_LOGIN:"test account"},
  ];
  for(const entry of cases){
    const {cwd,result}=run(entry);
    try{assert.notEqual(result.status,0,JSON.stringify(entry));}
    finally{rmSync(cwd,{recursive:true,force:true});}
  }
});
