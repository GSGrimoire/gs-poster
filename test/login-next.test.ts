// Issue #88: the post-login return path must stay on GS Poster.
// Unit cases for safeNext, plus the real /login route in workerd storing only
// a safe path in the OAuth state. No GitHub request is made.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { safeNext } from "../src/origin.ts";
import { sha256 } from "../src/session.ts";

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

let mf: Miniflare;
before(async () => {
  const out = await build({ entryPoints: ["test/fixtures/web-entry.ts"], bundle: true, format: "esm",
    platform: "neutral", target: "es2022", write: false, external: ["cloudflare:*", "node:*"],
    conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], logLevel: "silent" });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, cf: false, script: out.outputFiles[0].text,
    compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"], kvNamespaces: ["OAUTH_KV"],
    bindings: { COOKIE_SECRET: "login-next-test-cookie-secret", ALLOWED_GITHUB_LOGINS: "gsgrimoire",
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
