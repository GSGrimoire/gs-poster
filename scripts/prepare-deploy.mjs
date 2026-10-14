#!/usr/bin/env node
/**
 * Runs in GitHub Actions before `wrangler deploy`.
 * - finds the Cloudflare account (from CLOUDFLARE_ACCOUNT_ID or the token),
 * - checks the account has a workers.dev subdomain,
 * - creates the KV namespace and D1 database on first run, reuses them after,
 * - writes wrangler.generated.jsonc with the real ids.
 * Needs only CLOUDFLARE_API_TOKEN. Prints no secrets.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const API = "https://api.cloudflare.com/client/v4";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const KV_TITLE = "gs-poster-oauth";
const D1_NAME = "gs-poster-db";

if (!TOKEN) fail("CLOUDFLARE_API_TOKEN is not set. Add it under the repo's Settings → Secrets and variables → Actions.");

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!body.success) {
    const err = new Error((body.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`);
    err.codes = (body.errors || []).map((e) => e.code);
    err.status = res.status;
    throw err;
  }
  return body.result;
}

async function accountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const accounts = await cf("/accounts?per_page=50").catch((e) => fail(`Could not list accounts with this token (${e.message}). Give it "Account Settings: Read", or set CLOUDFLARE_ACCOUNT_ID.`));
  if (accounts.length !== 1) fail(`The token can see ${accounts.length} accounts. Set the CLOUDFLARE_ACCOUNT_ID secret to choose one.`);
  return accounts[0].id;
}

const acct = await accountId();

let subdomain;
try {
  subdomain = (await cf(`/accounts/${acct}/workers/subdomain`)).subdomain;
} catch (e) {
  fail(`This account has no workers.dev subdomain yet. Open dash.cloudflare.com → Workers & Pages once and pick one, then re-run. (${e.message})`);
}
if (!subdomain) fail("This account has no workers.dev subdomain yet. Open dash.cloudflare.com → Workers & Pages once and pick one, then re-run.");

const namespaces = await cf(`/accounts/${acct}/storage/kv/namespaces?per_page=100`);
let kv = namespaces.find((n) => n.title === KV_TITLE);
if (!kv) {
  kv = await cf(`/accounts/${acct}/storage/kv/namespaces`, { method: "POST", body: JSON.stringify({ title: KV_TITLE }) });
  console.log(`Created KV namespace ${KV_TITLE}`);
} else console.log(`Using KV namespace ${KV_TITLE}`);

const dbs = await cf(`/accounts/${acct}/d1/database?name=${encodeURIComponent(D1_NAME)}`).catch((e) =>
  fail(`Could not read D1 databases (${e.message}). The token needs "D1: Edit".`),
);
let d1 = dbs.find((d) => d.name === D1_NAME);
if (!d1) {
  d1 = await cf(`/accounts/${acct}/d1/database`, { method: "POST", body: JSON.stringify({ name: D1_NAME }) });
  console.log(`Created D1 database ${D1_NAME}`);
} else console.log(`Using D1 database ${D1_NAME}`);

// wrangler.jsonc → JSON: drop whole-line comments (there are no trailing ones).
const src = readFileSync("wrangler.jsonc", "utf8")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
const config = JSON.parse(src);
config.account_id = acct;
config.kv_namespaces = [{ binding: "OAUTH_KV", id: kv.id }];
config.d1_databases = [{ binding: "DB", database_name: D1_NAME, database_id: d1.uuid }];
delete config.$schema;
writeFileSync("wrangler.generated.jsonc", JSON.stringify(config, null, 2) + "\n");

const url = `https://${config.name}.${subdomain}.workers.dev`;
console.log(`Worker URL: ${url}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\naccount_id=${acct}\n`);
