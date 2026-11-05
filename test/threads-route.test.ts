// Threads through the real web router in workerd: PIN-gated connect and
// disconnect, the callback's session and lockout gates, Meta's signed
// callbacks, the editor card and save, and PIN-gated job controls.
// No request leaves the test; every secret and PIN is a test value.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createPost, ensureSchema, getPost } from "../src/db.ts";
import { ensureThreadsSchema } from "../src/threads.ts";
import { ensureThreadsJobs, getThreadsJob } from "../src/threads-publish.ts";
import { csrfToken, makeSession, SESSION_COOKIE, type Session } from "../src/session.ts";
import type { Env } from "../src/env.ts";

const ORIGIN = "https://gs-poster.test";
const SECRET = "threads-route-test-cookie-secret";
const PIN = "864209"; // test-only value
const signer = { COOKIE_SECRET: SECRET, ALLOWED_GITHUB_LOGINS: "gsgrimoire" } as Env;
let mf: Miniflare, db: D1Database;

before(async () => {
  const out = await build({ entryPoints: ["test/fixtures/web-entry.ts"], bundle: true, format: "esm",
    platform: "neutral", target: "es2022", write: false, external: ["cloudflare:*", "node:*"],
    conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], logLevel: "silent" });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, cf: false, script: out.outputFiles[0].text,
    compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"],
    bindings: { COOKIE_SECRET: SECRET, ALLOWED_GITHUB_LOGINS: "gsgrimoire", APPROVE_PIN: PIN, TIMEZONE: "Europe/Copenhagen",
      THREADS_APP_ID: "123456789", THREADS_APP_SECRET: "test-only-threads-app-secret" } }));
  db = await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
  await ensureThreadsSchema(db);
  await ensureThreadsJobs(db);
});
after(async () => { await mf?.dispose(); });

async function session(login = "GSGrimoire") {
  const raw = await makeSession(signer, login);
  return { raw, csrf: await csrfToken(signer, { login, raw } as Session) };
}
async function post(path: string, fields: Record<string, string>, o: { origin?: string; csrf?: string } = {}) {
  const s = await session();
  return mf.dispatchFetch(ORIGIN + path, { method: "POST", redirect: "manual",
    body: new URLSearchParams({ csrf: o.csrf ?? s.csrf, ...fields }).toString(),
    headers: { Origin: o.origin ?? ORIGIN, "Sec-Fetch-Site": o.origin ? "cross-site" : "same-origin",
      "Content-Type": "application/x-www-form-urlencoded", Cookie: SESSION_COOKIE + "=" + s.raw } });
}
async function get(path: string) {
  const s = await session();
  return mf.dispatchFetch(ORIGIN + path, { headers: { Cookie: SESSION_COOKIE + "=" + s.raw }, redirect: "manual" });
}
const states = async () => (await db.prepare("SELECT COUNT(*) AS n FROM threads_oauth_states").first<{ n: number }>())!.n;

test("connect needs the PIN and same-site CSRF before any sign-in state is created", async () => {
  const page = await (await get("/threads/settings")).text();
  assert.match(page, /action="\/threads\/connect"/);
  assert.match(page, /id="threads-connect-pin"/);
  assert.equal((await post("/threads/connect", { pin: "000000" })).status, 403);
  assert.equal((await post("/threads/connect", {})).status, 403);
  assert.equal((await post("/threads/connect", { pin: PIN }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/threads/connect", { pin: PIN }, { csrf: "forged" })).status, 403);
  assert.equal(await states(), 0);
  const ok = await post("/threads/connect", { pin: PIN });
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /id="threads-continue-link"[^>]*href="https:\/\/threads\.net\/oauth\/authorize\?/);
  assert.match(ok.headers.get("set-cookie") ?? "", /^__Host-gsp_threads_state=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  assert.equal(await states(), 1);
  const js = await get("/threads-connect.js");
  assert.match(await js.text(), /threads\.net/);
});

test("the callback needs a signed-in session and refuses during a PIN lockout", async () => {
  const anon = await mf.dispatchFetch(ORIGIN + "/threads/callback?code=x&state=y", { redirect: "manual" });
  assert.equal(anon.status, 401);
  const res = await get("/threads/callback?code=x&state=y");
  assert.equal(res.status, 400, "no matching browser cookie");
  for (let i = 0; i < 5; i++) await post("/threads/disconnect", { pin: "000001", confirm: "yes" });
  const locked = await get("/threads/callback?code=x&state=y");
  assert.equal(locked.status, 429);
  await db.prepare("DELETE FROM pin_failures").run().catch(() => undefined);
});

test("Meta's account callbacks are public but refuse unsigned or forged requests", async () => {
  for (const path of ["/threads/deauthorize", "/threads/delete"]) {
    const unsigned = await mf.dispatchFetch(ORIGIN + path, { method: "POST", body: new URLSearchParams({ signed_request: "abc.def" }) });
    assert.equal(unsigned.status, 400, path);
  }
  const get = await mf.dispatchFetch(ORIGIN + "/threads/delete");
  assert.equal(get.status, 405);
  const media = await mf.dispatchFetch(ORIGIN + "/threads/media/" + "d".repeat(43) + ".jpg");
  assert.equal(media.status, 404);
});

test("the editor shows the Threads chip and card, and saving keeps its text and photo choice", async () => {
  const p = await createPost(db, { message: "Cave.", label: "Cave", release: null, images: [], video: null,
    created_by: "test", scheduled_at: null } as any);
  const html = await (await get("/post/" + p.id)).text();
  assert.match(html, /name="p_threads"/);
  assert.match(html, /id="target-threads"/);
  assert.match(html, /name="th_media"/);
  const saved = await post(`/post/${p.id}/save`, { expected_updated_at: p.updated_at, p_facebook: "1", p_threads: "1",
    th_caption: "Into the cave", th_media: "facebook", auto: "1", message: "Cave." });
  assert.equal(saved.status, 200, await saved.clone().text());
  const after = (await getPost(db, p.id))!;
  assert.deepEqual(after.threads, { caption: "Into the cave", media: "facebook" });
  const tooLong = await post(`/post/${p.id}/save`, { expected_updated_at: after.updated_at, p_facebook: "1", p_threads: "1",
    th_caption: "x".repeat(501), th_media: "none", auto: "1", message: "Cave." });
  assert.equal(tooLong.status, 400);
  const badMedia = await post(`/post/${p.id}/save`, { expected_updated_at: after.updated_at, p_facebook: "1", p_threads: "1",
    th_caption: "ok", th_media: "tiktok", auto: "1", message: "Cave." });
  assert.equal(badMedia.status, 400);
});

test("Threads job controls need the PIN, and closing an unclear result needs the owner's tick", async () => {
  const p = await createPost(db, { message: "Cave.", label: "Cave", release: null, images: [], video: null,
    created_by: "test", scheduled_at: null } as any);
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO threads_jobs (post_id, status, kind, due_at, text, items, created_by, updated_at, account_id)
    VALUES (?, 'scheduled', 'TEXT', ?, 'Into the cave', '[]', 'gsgrimoire', ?, '17841400000000077')`).bind(p.id, new Date(Date.now() + 3600_000).toISOString(), now).run();
  const page = await (await get("/post/" + p.id)).text();
  assert.match(page, /Threads publishing/);
  assert.equal((await post(`/post/${p.id}/threads-cancel`, { pin: "111111" })).status, 403);
  assert.equal((await getThreadsJob(db, p.id))!.status, "scheduled");
  assert.equal((await post(`/post/${p.id}/threads-cancel`, { pin: PIN })).status, 200);
  assert.equal((await getThreadsJob(db, p.id))!.status, "cancelled");
  await db.prepare("UPDATE threads_jobs SET status = 'failed', ambiguous = 1 WHERE post_id = ?").bind(p.id).run();
  assert.equal((await post(`/post/${p.id}/threads-close`, { pin: PIN })).status, 400);
  assert.equal((await post(`/post/${p.id}/threads-retry`, { pin: PIN })).status, 409);
  assert.equal((await post(`/post/${p.id}/threads-close`, { pin: PIN, confirmed_not_on_threads: "1" })).status, 200);
});

test("a signed-in approval with the PIN queues a Threads text post", async () => {
  const { sealThreadsToken } = await import("../src/threads.ts");
  const { saveEditorDraft } = await import("../src/db.ts");
  const sealed = await sealThreadsToken({ COOKIE_SECRET: SECRET } as Env, "test-only-threads-token");
  await db.prepare(`INSERT OR REPLACE INTO threads_accounts (account_key, user_id, username, token_cipher, connected_by, expires_at, issued_at, updated_at)
    VALUES ('primary', '17841400000000077', 'gsgrimoire', ?, 'gsgrimoire', ?, ?, ?)`)
    .bind(sealed, Math.floor(Date.now() / 1000) + 50 * 86400, Math.floor(Date.now() / 1000), new Date().toISOString()).run();
  const p = await createPost(db, { message: "Cave.", label: "Cave", release: null, images: [], video: null,
    created_by: "test", scheduled_at: null } as any);
  assert.ok(await saveEditorDraft(db, p.id, p.updated_at, { message: "Cave.", tiktok_caption: null, tiktok_title: null, images: [],
    tiktok_images: null, video: null, tiktok_video: null, facebook_enabled: false, tiktok_enabled: false, scheduled_at: null,
    label: "Cave", release: null, bluesky_enabled: false, instagram_enabled: false, threads_enabled: true }, null, undefined,
    { caption: "Into the cave", media: "none" }));
  const cur = (await getPost(db, p.id))!;
  const html = await (await get("/post/" + p.id)).text();
  assert.match(html, /name="target_threads" value="1" checked/);
  const res = await post(`/post/${p.id}/approve`, { expected_updated_at: cur.updated_at, target_threads: "1", confirm_threads: "1", pin: PIN });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Threads: approved, posts within a few minutes/);
  const job = (await getThreadsJob(db, p.id))!;
  assert.equal(job.status, "scheduled");
  assert.equal(job.kind, "TEXT");
  assert.equal(job.text, "Into the cave");
});

test("T1: an approved Threads post cannot be re-timed, switched off or rejected through the router, alone or with Instagram", async () => {
  const p = await createPost(db, { message: "Cave.", label: "Cave", release: null, images: [], video: null,
    created_by: "test", scheduled_at: new Date(Date.now() + 2 * 86400_000).toISOString() } as any);
  const due = p.scheduled_at!;
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO threads_targets (post_id, caption, media, status) VALUES (?, 'Into the cave', 'none', 'draft')").bind(p.id).run();
  await db.prepare(`INSERT INTO threads_jobs (post_id, status, kind, due_at, text, items, created_by, updated_at, account_id)
    VALUES (?, 'scheduled', 'TEXT', ?, 'Into the cave', '[]', 'gsgrimoire', ?, '17841400000000077')`).bind(p.id, due, now).run();
  const cur = (await getPost(db, p.id))!;
  const save = (extra: Record<string, string>) => post(`/post/${p.id}/save`, { expected_updated_at: cur.updated_at, auto: "1",
    message: "Cave.", p_facebook: "1", p_threads: "1", th_caption: "Into the cave", th_media: "none", ...extra });
  const moved = await save({ when: "2030-01-01T18:00" });
  assert.equal(moved.status, 409);
  assert.match(await moved.text(), /approved for Threads, so its time is locked/);
  const off = await save({ p_threads: "0" });
  assert.equal(off.status, 409);
  assert.match(await off.text(), /Threads cannot be switched off/);
  const rejected = await post(`/post/${p.id}/reject`, { reason: "no" });
  assert.equal(rejected.status, 409);
  assert.match(await rejected.text(), /approved for Threads/);
  // The same post also approved for Instagram: either job alone keeps it frozen.
  await db.prepare(`INSERT INTO instagram_jobs (post_id, status, kind, due_at, caption, frame, items, created_by, updated_at)
    VALUES (?, 'scheduled', 'IMAGE', ?, 'x', '4:5', '[]', 'gsgrimoire', ?)`).bind(p.id, due, now).run();
  await db.prepare("UPDATE threads_jobs SET status = 'cancelled' WHERE post_id = ?").bind(p.id).run();
  assert.equal((await post(`/post/${p.id}/reject`, { reason: "no" })).status, 409, "Instagram still pending");
  const after = (await getPost(db, p.id))!;
  assert.equal(after.status, "draft");
  assert.equal(after.scheduled_at, due);
  assert.equal((await getThreadsJob(db, p.id))!.due_at, due);
});
