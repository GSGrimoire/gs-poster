// Threads through the real web router in workerd: PIN-gated connect and
// disconnect, the callback's session and lockout gates, Meta's signed
// callbacks, the editor card and save, and PIN-gated job controls.
// No request leaves the test; every secret and PIN is a test value.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createPost, ensureSchema, getPost } from "../src/db.ts";
import { ensureThreadsSchema, threadsAccessToken } from "../src/threads.ts";
import { ensureThreadsJobs, getThreadsJob } from "../src/threads-publish.ts";
import { csrfToken, makeSession, SESSION_COOKIE, type Session } from "../src/session.ts";
import type { Env } from "../src/env.ts";

const ORIGIN = "https://gs-poster.test";
const SECRET = "threads-route-test-cookie-secret";
const APP_SECRET = "test-only-threads-app-secret";
const ACCOUNT_ID = "17841400000000077";
const PIN = "864209"; // test-only value
const signer = { COOKIE_SECRET: SECRET, ALLOWED_GITHUB_LOGINS: "gsgrimoire" } as Env;
let mf: Miniflare, db: D1Database;

before(async () => {
  const out = await build({ entryPoints: ["test/fixtures/web-entry.ts"], bundle: true, format: "esm",
    platform: "neutral", target: "es2022", write: false, external: ["cloudflare:*", "node:*"],
    conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], logLevel: "silent" });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, cf: false, script: out.outputFiles[0].text,
    compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"],
    outboundService: async (req: Request) => {
      const url = new URL(req.url);
      if (url.hostname === "graph.facebook.com" && url.pathname.endsWith("/failed-cancel-test-post") && req.method === "DELETE")
        return Response.json({ error: { code: 1, message: "unconfirmed test delete" } }, { status: 503 });
      if (url.hostname === "graph.facebook.com" && url.pathname.endsWith("/missing-test-post"))
        return Response.json({ error: { code: 100, message: "missing test post" } }, { status: 404 });
      assert.equal(url.hostname, "graph.threads.net");
      if (url.pathname === "/oauth/access_token") return Response.json({ access_token: "test-short-token" });
      if (url.pathname === "/access_token") return Response.json({ access_token: "test-long-token", expires_in: 60 * 86400 });
      if (url.pathname === "/v1.0/me") return Response.json({ id: ACCOUNT_ID, username: "gsgrimoire" });
      return new Response("Blocked in test", { status: 599 });
    },
    bindings: { COOKIE_SECRET: SECRET, ALLOWED_GITHUB_LOGINS: "gsgrimoire", APPROVE_PIN: PIN, TIMEZONE: "Europe/Copenhagen",
      THREADS_APP_ID: "123456789", THREADS_APP_SECRET: APP_SECRET,
      FB_PAGE_ID: "12345", FB_PAGE_TOKEN: "test-only-facebook-token" } }));
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
  await db.prepare(`INSERT OR REPLACE INTO threads_accounts (account_key, user_id, username, token_cipher, connected_by, expires_at, issued_at, updated_at, connected_at)
    VALUES ('primary', '17841400000000077', 'gsgrimoire', ?, 'gsgrimoire', ?, ?, ?, ?)`)
    .bind(sealed, Math.floor(Date.now() / 1000) + 50 * 86400, Math.floor(Date.now() / 1000), new Date().toISOString(), Math.floor(Date.now() / 1000)).run();
  const p = await createPost(db, { message: "Cave.", label: "Cave", release: null, images: [], video: null,
    created_by: "test", scheduled_at: null } as any);
  assert.ok(await saveEditorDraft(db, p.id, p.updated_at, { message: "Cave.", tiktok_caption: null, tiktok_title: null, images: [],
    tiktok_images: null, video: null, tiktok_video: null, facebook_enabled: false, tiktok_enabled: false, scheduled_at: null,
    label: "Cave", release: null, bluesky_enabled: false, instagram_enabled: false, threads_enabled: true }, null, undefined,
    { caption: "Into the cave", media: "none" }));
  const cur = (await getPost(db, p.id))!;
  const html = await (await get("/post/" + p.id)).text();
  assert.match(html, /name="target_threads" value="1" checked/);
  assert.match(html, new RegExp('name="expected_threads_account" value="' + ACCOUNT_ID + '"'));
  const approve = (account: string) => post(`/post/${p.id}/approve`, {
    expected_updated_at: cur.updated_at, target_threads: "1", confirm_threads: "1", pin: PIN,
    expected_threads_account: account,
  });
  const changed = await approve("17841400000000099");
  assert.equal(changed.status, 409);
  assert.match(await changed.text(), /The Threads account changed/);
  assert.equal(await getThreadsJob(db, p.id), null);
  const res = await approve(ACCOUNT_ID);
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

test("T5: Meta's public callbacks refuse a declared oversize body and malformed bodies through the router", async () => {
  // (A streamed body with no declared size is tested on the handler directly in
  // test/threads.test.ts, where the early refusal cannot race the sending client.)
  // A declared size over the limit is refused before reading.
  const declared = await mf.dispatchFetch(ORIGIN + "/threads/delete", { method: "POST", body: "signed_request=" + "b".repeat(9000) });
  assert.equal(declared.status, 413);
  for (const body of ["", "%%%", "--boundary\r\nContent-Disposition: form-data; name=signed_request\r\n\r\nx.y\r\n--boundary--"]) {
    const res = await mf.dispatchFetch(ORIGIN + "/threads/deauthorize", { method: "POST", body,
      headers: { "Content-Type": "multipart/form-data; boundary=boundary" } });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test("T4: both signed public callbacks fail closed for genuine early events and old same-account replays", async () => {
  const account = () => db.prepare("SELECT connected_at, token_cipher, suspended_at, suspended_kind, suspended_issued_at FROM threads_accounts")
    .first<{ connected_at: number; token_cipher: string; suspended_at: number | null; suspended_kind: string | null; suspended_issued_at: number | null }>();
  const signedCallback = (path: string, issuedAt: number) => {
    const payload = Buffer.from(JSON.stringify({
      algorithm: "HMAC-SHA256", user_id: ACCOUNT_ID, issued_at: issuedAt,
    })).toString("base64url");
    const sig = createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
    return mf.dispatchFetch(ORIGIN + path, {
      method: "POST", body: new URLSearchParams({ signed_request: sig + "." + payload }),
    });
  };
  const connectViaRouter = async () => {
    const s = await session();
    const start = await mf.dispatchFetch(ORIGIN + "/threads/connect", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded", Cookie: SESSION_COOKIE + "=" + s.raw },
      body: new URLSearchParams({ csrf: s.csrf, pin: PIN }),
    });
    assert.equal(start.status, 200);
    const stateCookie = start.headers.get("set-cookie")!.split(";")[0];
    const state = stateCookie.split("=")[1];
    const connected = await mf.dispatchFetch(ORIGIN + "/threads/callback?code=test-code&state=" + state, {
      headers: { Cookie: SESSION_COOKIE + "=" + s.raw + "; " + stateCookie }, redirect: "manual",
    });
    assert.equal(connected.status, 303);
    const current = (await account())!;
    assert.ok(current.token_cipher);
    assert.equal(current.suspended_at, null);
    return current;
  };
  const recover = async () => {
    assert.equal((await post("/threads/disconnect", { pin: PIN, confirm: "yes" })).status, 303);
    assert.equal(await account(), null);
    return connectViaRouter();
  };
  const protectedToken = () => threadsAccessToken({ DB: db, THREADS_APP_ID: "123456789",
    THREADS_APP_SECRET: APP_SECRET, COOKIE_SECRET: SECRET } as Env);
  for (const path of ["/threads/deauthorize"]) {
    // Real callback issued during the first 0-300 seconds of authorization.
    for (const offset of [0, 30, 299, 300]) {
      const current = await recover();
      const response = await signedCallback(path, current.connected_at + offset);
      assert.equal(response.status, 200, path + " early offset " + offset);
      if (path.endsWith("/delete"))
        assert.match((await response.json() as { confirmation_code: string }).confirmation_code, /^[A-Za-z0-9_-]{16}$/);
      assert.ok((await account())!.suspended_at != null, "the early callback persists a suspension");
      await assert.rejects(protectedToken(), /suspended/);
      assert.match(await (await get("/threads/settings")).text(), /Posting suspended/);
      assert.equal((await post("/threads/connect", { pin: PIN })).status, 400,
        "only the PIN-gated disconnect and new OAuth flow can clear the hold");
    }

    // Same-account A disconnect/reconnect in the same second, then replay A's
    // old signed event. The database timestamp is set equal for determinism.
    const old = await recover();
    const fresh = await recover();
    await db.prepare("UPDATE threads_accounts SET connected_at = ?").bind(old.connected_at).run();
    assert.equal((await account())!.connected_at, old.connected_at);
    const replay = await signedCallback(path, old.connected_at);
    assert.equal(replay.status, 200);
    assert.ok((await account())!.suspended_at != null, "old event cannot leave a newer sign-in publishable");
    await assert.rejects(protectedToken(), /suspended/);

    // Replaying the identical signed request after an authorized PIN recovery
    // must also block again, even though its event digest is already recorded.
    await recover();
    assert.equal((await signedCallback(path, old.connected_at)).status, 200);
    assert.ok((await account())!.suspended_at != null, "deduplication does not bypass the posting fence");

    // An unambiguously later callback is also fail-closed.
    const later = await recover();
    await db.prepare("UPDATE threads_accounts SET connected_at = connected_at - 601").run();
    assert.equal((await signedCallback(path, later.connected_at)).status, 200);
    assert.ok((await account())!.suspended_at != null);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM threads_revocation_events WHERE kind = ?")
      .bind(path.endsWith("/delete") ? "delete" : "deauthorize").first<{ n: number }>();
    assert.ok((count?.n ?? 0) >= 1, "signed event evidence is durable");
    assert.equal((await post("/threads/disconnect", { pin: "111111", confirm: "yes" })).status, 403);
    assert.ok((await account())!.suspended_at != null, "wrong PIN cannot clear the suspension");
  }
  await recover();
});


test("T6: signed data deletion erases credentials and provider identifiers, and returns an idempotent public receipt", async () => {
  // Exercise the production router and durable D1, including an in-flight send
  // which must remain visibly unclear rather than be falsely called cancelled.
  await post("/threads/disconnect", { pin: PIN, confirm: "yes" });
  const s = await session();
  const start = await mf.dispatchFetch(ORIGIN + "/threads/connect", {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded",
      Cookie: SESSION_COOKIE + "=" + s.raw },
    body: new URLSearchParams({ csrf: s.csrf, pin: PIN }),
  });
  assert.equal(start.status, 200);
  const stateCookie = start.headers.get("set-cookie")!.split(";")[0];
  const state = stateCookie.split("=")[1];
  const connected = await mf.dispatchFetch(ORIGIN + "/threads/callback?code=test-code&state=" + state, {
    headers: { Cookie: SESSION_COOKIE + "=" + s.raw + "; " + stateCookie },
  });
  assert.equal(connected.status, 303);
  const account = await db.prepare("SELECT user_id, token_cipher FROM threads_accounts").first<{user_id:string;token_cipher:string}>();
  assert.equal(account?.user_id, ACCOUNT_ID);
  const now = new Date().toISOString(), due = new Date(Date.now() - 60000).toISOString();
  const p = await createPost(db, { message:"Editorial draft retained", label:"test", release:null,
    images:[], video:null, created_by:"test", scheduled_at:due } as any);
  const q = await createPost(db, { message:"Other draft retained", label:"test", release:null,
    images:[], video:null, created_by:"test", scheduled_at:due } as any);
  await db.batch([
    db.prepare(`INSERT INTO threads_jobs
      (post_id,status,kind,due_at,text,items,created_by,updated_at,account_id,account_username,container_id,children,media_id,permalink,error,generation)
      VALUES (?,'scheduled','TEXT',?,'Hello','[]','test',?,?,?,'remote-container','["remote-child"]','remote-post','https://www.threads.net/@test/post/1','remote error','old-generation')`)
      .bind(p.id,due,now,ACCOUNT_ID,"gsgrimoire"),
    db.prepare(`INSERT INTO threads_jobs
      (post_id,status,kind,due_at,text,items,created_by,updated_at,account_id,account_username,container_id,generation,lease_until)
      VALUES (?,'sending','TEXT',?,'Hello','[]','test',?,?,?,'inflight-container','inflight-generation',?)`)
      .bind(q.id,due,now,ACCOUNT_ID,"gsgrimoire",new Date(Date.now()+300000).toISOString()),
    db.prepare("INSERT INTO threads_media_grants (token_hash,post_id,item_index,expires_at,generation) VALUES ('grant-test',?,0,?,'old-generation')")
      .bind(p.id,Math.floor(Date.now()/1000)+1000),
    db.prepare("INSERT INTO threads_revocation_events (event_hash,user_id,kind,issued_at,received_at) VALUES ('event-test',?,'deauthorize',?,?)")
      .bind(ACCOUNT_ID,Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)),
    db.prepare("INSERT INTO audit (ts,actor,action,post_id,detail) VALUES (?,'test','threads-queued',?,?)")
      .bind(now,p.id,"provider account " + ACCOUNT_ID),
  ]);
  const payload = Buffer.from(JSON.stringify({algorithm:"HMAC-SHA256",user_id:ACCOUNT_ID,issued_at:Math.floor(Date.now()/1000)})).toString("base64url");
  const signed = createHmac("sha256",APP_SECRET).update(payload).digest("base64url") + "." + payload;
  const callback = (value:string) => mf.dispatchFetch(ORIGIN + "/threads/delete", {
    method:"POST",body:new URLSearchParams({signed_request:value}),
  });
  assert.equal((await callback("forged." + payload)).status,400);
  assert.equal((await db.prepare("SELECT token_cipher FROM threads_accounts").first<{token_cipher:string}>())?.token_cipher,account!.token_cipher);
  const response = await callback(signed);
  assert.equal(response.status,200);
  const receipt = await response.json() as {url:string;confirmation_code:string};
  assert.match(receipt.confirmation_code,/^[A-Za-z0-9_-]{32}$/);
  assert.match(receipt.url,/\/threads\/delete\/status\/[A-Za-z0-9_-]{32}$/);
  assert.equal(await db.prepare("SELECT * FROM threads_accounts").first(),null);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM threads_media_grants").first<{n:number}>())?.n,0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM threads_revocation_events WHERE user_id=?").bind(ACCOUNT_ID).first<{n:number}>())?.n,0);
  const cancelled = (await getThreadsJob(db,p.id))!;
  assert.equal(cancelled.status,"cancelled","scheduled work was cancelled");
  const unclear = (await getThreadsJob(db,q.id))!;
  assert.equal(unclear.status,"failed");
  assert.equal(unclear.ambiguous,true,"final send remains uncertain");
  assert.notEqual(unclear.generation,"inflight-generation","late Workers cannot restore deleted metadata");
  for (const j of [cancelled,unclear]) {
    assert.equal(j.account_id,"");
    assert.equal(j.account_username,"");
    assert.equal(j.container_id,null);
    assert.equal(j.media_id,null);
    assert.equal(j.permalink,null);
    assert.deepEqual(j.children,[]);
    assert.equal(j.lease_until,null);
  }
  assert.equal((await db.prepare("SELECT detail FROM audit WHERE action='threads-queued' AND post_id=?").bind(p.id).first<{detail:string|null}>())?.detail,null);
  const url = ORIGIN + new URL(receipt.url).pathname;
  const status = await mf.dispatchFetch(url);
  assert.equal(status.status,200);
  assert.equal(status.headers.get("cache-control"),"no-store");
  assert.match(await status.text(),/Threads data deletion completed/);
  assert.equal((await mf.dispatchFetch(ORIGIN + "/threads/delete/status/" + "x".repeat(32))).status,404);
  assert.equal((await mf.dispatchFetch(url,{method:"POST"})).status,405);
  assert.match(await (await mf.dispatchFetch(ORIGIN + "/privacy")).text(),/Threads revocation and data deletion/);
  assert.deepEqual(await (await callback(signed)).json(),receipt,"retries have stable confirmation data");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM threads_deletion_requests").first<{n:number}>())?.n,1);
  assert.equal((await getThreadsJob(db,p.id))!.status,"cancelled");
  assert.ok(await getPost(db,p.id),"owner-authored content was not erased");
});

test("Facebook recovery and cancellation preserve active Threads jobs", async () => {
  for (const [status, action, jobStatus, fields] of [
    ["failed", "redraft", "scheduled", { confirmed_no_facebook: "1" }],
    ["cancelled", "restore-cancelled", "sending", { confirmed_cancelled: "1", pin: PIN }],
    ["scheduled", "cancel", "sending", { pin: PIN }],
  ] as const) {
    const due = new Date(Date.now() + 3600_000).toISOString();
    const p = await createPost(db, { message: "Cave.", label: "Cave", release: null, images: [], video: null,
      created_by: "test", scheduled_at: due } as any);
    await db.batch([
      db.prepare("UPDATE posts SET status=?, approved_at=? WHERE id=?").bind(status, p.updated_at, p.id),
      db.prepare(`INSERT INTO threads_jobs (post_id, status, kind, due_at, text, items, created_by, updated_at, account_id)
        VALUES (?, ?, 'TEXT', ?, 'Into the cave', '[]', 'gsgrimoire', ?, ?)`).bind(p.id, jobStatus, due, p.updated_at, ACCOUNT_ID),
    ]);
    const before = await getPost(db, p.id);
    const res = await post(`/post/${p.id}/${action}`, { ...fields, expected_updated_at: p.updated_at });
    assert.equal(res.status, 409, action);
    assert.deepEqual(await getPost(db, p.id), before, action + " preserves the post");
    assert.equal((await getThreadsJob(db, p.id))!.status, jobStatus);
    assert.equal((await getThreadsJob(db, p.id))!.due_at, due);
  }
});

test("a planner read cannot cancel a Threads job when its Facebook sibling is missing", async () => {
  const due = new Date(Date.now() - 3600_000).toISOString();
  const p = await createPost(db, { message: "Cave.", label: "Cave", release: null, images: [], video: null,
    created_by: "test", scheduled_at: due, facebook_enabled: true } as any);
  await db.batch([
    db.prepare("UPDATE posts SET status='scheduled', approved_at=?, fb_post_id='missing-test-post' WHERE id=?").bind(p.updated_at, p.id),
    db.prepare(`INSERT INTO threads_jobs (post_id, status, kind, due_at, text, items, created_by, updated_at, account_id)
      VALUES (?, 'scheduled', 'TEXT', ?, 'Into the cave', '[]', 'gsgrimoire', ?, ?)`).bind(p.id, due, p.updated_at, ACCOUNT_ID),
  ]);
  assert.equal((await get("/")).status, 200);
  assert.equal((await getPost(db, p.id))!.status, "cancelled");
  assert.equal((await getThreadsJob(db, p.id))!.status, "scheduled");
});

test("an unconfirmed Facebook cancellation cannot restart a stopped Threads job", async () => {
  const due = new Date(Date.now() + 3600_000).toISOString();
  const p = await createPost(db, { message: "Cave.", label: "Cave", release: null, images: [], video: null,
    created_by: "test", scheduled_at: due, facebook_enabled: true } as any);
  await db.batch([
    db.prepare("UPDATE posts SET status='scheduled', approved_at=?, fb_post_id='failed-cancel-test-post' WHERE id=?").bind(p.updated_at, p.id),
    db.prepare(`INSERT INTO threads_jobs (post_id, status, kind, due_at, text, items, created_by, updated_at, account_id)
      VALUES (?, 'scheduled', 'TEXT', ?, 'Into the cave', '[]', 'gsgrimoire', ?, ?)`).bind(p.id, due, p.updated_at, ACCOUNT_ID),
  ]);
  const res = await post(`/post/${p.id}/cancel`, { pin: PIN });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /Threads was stopped. Facebook cancellation could not be confirmed/);
  assert.equal((await getPost(db, p.id))!.status, "scheduled");
  assert.equal((await getThreadsJob(db, p.id))!.status, "cancelled");
});
