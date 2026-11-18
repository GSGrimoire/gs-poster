// Issue #88: the post-login return path must stay on GS Poster.
// Unit cases for safeNext, the real /login route in workerd storing only a
// safe path in the OAuth state, and the real /callback route redirecting only
// to a safe path. GitHub is a local mock: every outbound request is recorded
// and answered here, so nothing leaves the test.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { safeNext } from "../src/origin.ts";
import { sha256, readSession, SESSION_COOKIE, LOGIN_STATE_COOKIE } from "../src/session.ts";
import type { Env } from "../src/env.ts";

const ORIGIN = "https://gs-poster.test";

/** What a browser would actually navigate to for this Location header. */
const lands = (location: string) => new URL(location, ORIGIN).origin;

test("#88: normal post-login destinations are kept", () => {
  for (const ok of ["/", "/post/abc123", "/calendar?week=2026-11-16", "/calendar?month=2026-11&view=month",
    "/drafts?q=cave%20map&page=2", "/post/abc/edit#instagram"]) {
    assert.equal(safeNext(ok), ok, ok);
  }
});

test("#88: backslash, protocol-relative, absolute and control-character paths fall back to /", () => {
  const bad = [
    "/\\evil.example/path", "/\\\\evil.example", "\\\\evil.example", "/\\/evil.example",
    "//evil.example", "///evil.example", "https://evil.example/", "javascript:alert(1)", "evil.example",
    "/\tevil", "/\n/evil.example", "/\r\n//evil.example", "/\u0000x", "/\u007fx", "\t//evil.example",
    "", "x".repeat(10),
  ];
  for (const b of bad) assert.equal(safeNext(b), "/", JSON.stringify(b));
  assert.equal(safeNext(null), "/");
  assert.equal(safeNext("/" + "a".repeat(3000)), "/", "overlong paths are refused");
});

test("#88: dot segments cannot collapse into a protocol-relative path", () => {
  for (const b of ["/.//evil.example", "/x/..//evil.example", "/%2e//evil.example"]) {
    const out = safeNext(b);
    assert.ok(!out.startsWith("//"), JSON.stringify(b) + " gave " + out);
    assert.equal(lands(out), ORIGIN, JSON.stringify(b));
  }
});

test("#88: percent-encoded backslashes and controls stay on this origin", () => {
  // searchParams.get decodes once: a single-encoded backslash arrives raw and is refused.
  const once = new URL(ORIGIN + "/login?next=%2F%5Cevil.example%2Fpath").searchParams.get("next");
  assert.equal(once, "/\\evil.example/path");
  assert.equal(safeNext(once), "/");
  const tab = new URL(ORIGIN + "/login?next=%2F%09%2Fevil.example").searchParams.get("next");
  assert.equal(safeNext(tab), "/");
  // Double-encoded values arrive still encoded and are only a path on this site.
  for (const enc of ["/%5Cevil.example/path", "/%5C%5Cevil.example", "/%09/evil.example", "/%2F%2Fevil.example"]) {
    const out = safeNext(enc);
    assert.equal(lands(out), ORIGIN, enc);
    assert.ok(!out.startsWith("//"), enc);
  }
});

// ---------------------------------------------------------------- the real /login route

const COOKIE_SECRET = "login-next-test-cookie-secret";
let mf: Miniflare;
/** The GitHub login the mocked /user endpoint returns. */
let githubLogin = "GSGrimoire";
const outbound: string[] = [];

/** Local stand-in for GitHub's token exchange, identity and token-revoke endpoints. */
function githubMock(req: Request): Response {
  const u = new URL(req.url);
  outbound.push(req.method + " " + u.origin + u.pathname);
  if (req.method === "POST" && u.href === "https://github.com/login/oauth/access_token") {
    return Response.json({ access_token: "test-only-github-token" });
  }
  if (req.method === "GET" && u.href === "https://api.github.com/user") return Response.json({ login: githubLogin });
  if (req.method === "DELETE" && u.href === "https://api.github.com/applications/test-client-id/token") {
    return new Response(null, { status: 204 });
  }
  return new Response("unexpected request in test", { status: 599 });
}

before(async () => {
  const out = await build({ entryPoints: ["test/fixtures/web-entry.ts"], bundle: true, format: "esm",
    platform: "neutral", target: "es2022", write: false, external: ["cloudflare:*", "node:*"],
    conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], logLevel: "silent" });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, cf: false, script: out.outputFiles[0].text,
    compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"], kvNamespaces: ["OAUTH_KV"],
    outboundService: githubMock,
    bindings: { COOKIE_SECRET, ALLOWED_GITHUB_LOGINS: "gsgrimoire",
      GITHUB_CLIENT_ID: "test-client-id", GITHUB_CLIENT_SECRET: "test-only-client-secret", TIMEZONE: "Europe/Copenhagen" } }));
});
after(async () => { await mf?.dispose(); });

async function storedNext(next: string): Promise<string> {
  const res = await mf.dispatchFetch(ORIGIN + "/login?next=" + encodeURIComponent(next), { redirect: "manual" });
  assert.equal(res.status, 302);
  const gh = new URL(res.headers.get("Location")!);
  assert.equal(gh.origin, "https://github.com", "the OAuth consent redirect is unchanged");
  assert.equal(gh.searchParams.get("redirect_uri"), ORIGIN + "/callback");
  const state = gh.searchParams.get("state")!;
  const kv = await mf.getKVNamespace("OAUTH_KV");
  const saved = await kv.get("gsp-login:" + await sha256(state), "json") as { next: string } | null;
  assert.ok(saved, "login state saved");
  return saved.next;
}

test("#88: /login stores only a safe return path in the sign-in state", async () => {
  assert.equal(await storedNext("/\\evil.example/path"), "/");
  assert.equal(await storedNext("//evil.example"), "/");
  assert.equal(await storedNext("https://evil.example"), "/");
  assert.equal(await storedNext("/\t/evil.example"), "/");
  assert.equal(await storedNext("/post/abc123"), "/post/abc123");
  assert.equal(await storedNext("/calendar?week=2026-11-16"), "/calendar?week=2026-11-16");
});

// ---------------------------------------------------------------- the real /callback route

const signer = { COOKIE_SECRET, ALLOWED_GITHUB_LOGINS: "gsgrimoire" } as Env;

/** Plant a sign-in state in KV as /login (or an older version of it) would have, then return to /callback. */
async function callbackWith(state: string, savedNext: string | null, cookieState = state) {
  const kv = await mf.getKVNamespace("OAUTH_KV");
  if (savedNext !== null) await kv.put("gsp-login:" + await sha256(state), JSON.stringify({ next: savedNext }), { expirationTtl: 600 });
  const res = await mf.dispatchFetch(ORIGIN + "/callback?code=test-code&state=" + encodeURIComponent(state), {
    redirect: "manual", headers: { Cookie: LOGIN_STATE_COOKIE + "=" + cookieState } });
  const cookies = res.headers.getSetCookie();
  const sessionValue = cookies.map((c) => c.split(";")[0]).find((c) => c.startsWith(SESSION_COOKIE + "="))?.slice(SESSION_COOKIE.length + 1);
  const session = sessionValue
    ? await readSession(signer, new Request(ORIGIN + "/", { headers: { Cookie: SESSION_COOKIE + "=" + sessionValue } }))
    : null;
  return { res, session, stored: await kv.get("gsp-login:" + await sha256(state)) };
}

test("#88: /callback sends an old unsafe saved destination to / and signs in only the allowlisted account", async () => {
  githubLogin = "GSGrimoire";
  for (const bad of ["/\\evil.example/path", "//evil.example", "https://evil.example/", "/\t/evil.example", "/.//evil.example"]) {
    outbound.length = 0;
    const { res, session, stored } = await callbackWith("state-" + bad.length + "-" + Math.random(), bad);
    assert.equal(res.status, 302, JSON.stringify(bad));
    assert.equal(res.headers.get("Location"), "/", JSON.stringify(bad));
    assert.equal(lands(res.headers.get("Location")!), ORIGIN);
    assert.equal(session?.login, "GSGrimoire", "a valid session for the allowlisted account");
    assert.equal(stored, null, "the sign-in state is used up");
    assert.deepEqual(outbound, ["POST https://github.com/login/oauth/access_token", "GET https://api.github.com/user",
      "DELETE https://api.github.com/applications/test-client-id/token"]);
  }
});

test("#88: /callback keeps a valid saved destination", async () => {
  githubLogin = "GSGrimoire";
  for (const ok of ["/post/abc123", "/calendar?week=2026-11-16", "/post/abc/edit#instagram"]) {
    const { res, session } = await callbackWith("state-ok-" + Math.random(), ok);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), ok);
    assert.equal(session?.login, "GSGrimoire");
  }
});

test("#88: a used sign-in state cannot be replayed", async () => {
  githubLogin = "GSGrimoire";
  const state = "state-replay-" + Math.random();
  const first = await callbackWith(state, "/post/abc123");
  assert.equal(first.res.status, 302);
  assert.ok(first.session);
  outbound.length = 0;
  const again = await callbackWith(state, null);
  assert.equal(again.res.status, 400);
  assert.equal(again.res.headers.get("Location"), null);
  assert.equal(again.session, null, "no session on replay");
  assert.deepEqual(outbound, [], "a replay never reaches GitHub");
});

test("#88: /callback refuses a state that is not bound to this browser", async () => {
  githubLogin = "GSGrimoire";
  outbound.length = 0;
  const { res, session, stored } = await callbackWith("state-bound-" + Math.random(), "/post/abc123", "another-browser-state");
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("Location"), null);
  assert.equal(session, null);
  assert.ok(stored, "a mismatched cookie does not consume the real browser's state");
  assert.deepEqual(outbound, []);
});

test("#88: /callback refuses an account that is not on the allowlist, even with a safe destination", async () => {
  githubLogin = "someone-else";
  try {
    const { res, session } = await callbackWith("state-deny-" + Math.random(), "/post/abc123");
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("Location"), null);
    assert.equal(session, null, "no session cookie for a refused account");
    assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith(SESSION_COOKIE + "=")));
  } finally { githubLogin = "GSGrimoire"; }
});
