/**
 * Generate an isolated, publication-disabled PR90 Worker configuration.
 * No production or shared resource is permitted; never prints secrets.
 * Required variables: PR90_WORKER_NAME, PR90_D1_DATABASE_ID,
 * PR90_KV_NAMESPACE_ID, PR90_R2_BUCKET, PR90_LOGIN.
 */
import {writeFileSync} from "node:fs";
const need=k=>{
  const value=(process.env[k]||"").trim();
  if(!value)throw Error("Missing isolated staging variable "+k);
  return value;
};
const worker=need("PR90_WORKER_NAME");
const db=need("PR90_D1_DATABASE_ID");
const kv=need("PR90_KV_NAMESPACE_ID");
const bucket=need("PR90_R2_BUCKET");
const login=need("PR90_LOGIN");
const dbUuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
if(!/^gs-poster-pr90-[a-z0-9-]{3,35}$/.test(worker) || !/^gs-poster-pr90-[a-z0-9-]{3,35}$/.test(bucket))
  throw Error("Staging Worker and R2 bucket names must begin gs-poster-pr90- and must not be production names.");
if(!dbUuid.test(db) || !/^[a-f0-9]{32}$/i.test(kv) || db.replaceAll("-","").toLowerCase()===kv.toLowerCase())
  throw Error("Use distinct real D1 and OAuth KV identifiers for staging.");
if(!/^[a-zA-Z0-9-]{1,39}$/.test(login))
  throw Error("Invalid staging GitHub sign-in account.");
const checkoutBranch=process.env.GITHUB_HEAD_REF
  ? "refs/heads/"+process.env.GITHUB_HEAD_REF : process.env.GITHUB_REF;
if(process.env.GITHUB_ACTIONS==="true" && checkoutBranch!=="refs/heads/feature/bluesky-gallery-redraft-video50-20261109")
  throw Error("Staging deployment must run from PR90's review branch, never main.");
if((process.env.PR90_STAGING_CONFIRM||"")!=="ISOLATED_STAGING_NO_PUBLISH")
  throw Error("Explicit staging-only confirmation is required.");
const config={
  $schema:"node_modules/wrangler/config-schema.json",
  name:worker,
  main:"src/pr90-staging-entry.ts",
  compatibility_date:"2026-09-01",
  compatibility_flags:["nodejs_compat","global_fetch_strictly_public"],
  workers_dev:true,
  observability:{enabled:true},
  triggers:{crons:[]},
  // Intentionally omit account-level Cloudflare Images: no shared production media service.
  kv_namespaces:[{binding:"OAUTH_KV",id:kv}],
  d1_databases:[{binding:"DB",database_name:worker+"-db",database_id:db}],
  r2_buckets:[{binding:"UPLOADS",bucket_name:bucket}],
  vars:{
    STAGING_NO_PUBLISH:"1",
    ALLOWED_GITHUB_LOGINS:login,
    GRAPH_VERSION:"v24.0",
    TIMEZONE:"Europe/Copenhagen",
  },
};
const output="wrangler.pr90-staging.generated.json";
writeFileSync(output,JSON.stringify(config,null,2)+"\n",{mode:0o600});
console.log("Isolated staging configuration generated: "+output);
console.log("Worker: "+worker+"; R2 bucket: "+bucket+"; cron: disabled; publishing: blocked; producer credentials: absent.");
