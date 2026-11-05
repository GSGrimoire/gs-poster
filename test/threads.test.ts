// Threads: sign-in state, encrypted token, renewal, Meta's signed callbacks,
// the release plan and the publishing state machine. Real D1 in workerd; all
// Threads API calls go to an in-process mock. Every secret is a test value.
import { before, beforeEach, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createPost, ensureSchema, getPost, saveEditorDraft, type EditorDraft, type ThreadsDraft } from "../src/db.ts";
import { defaultItem, type InstagramDraft } from "../src/instagram.ts";
import {
  beginThreadsConnection, disconnectThreads, ensureThreadsSchema, finishThreadsConnection, renewThreadsToken,
  sealThreadsToken, threadsAccountCallback, threadsConnection, unsealThreadsToken, verifySignedRequest, THREADS_STATE_COOKIE,
} from "../src/threads.ts";
import {
  closeAmbiguousThreadsJob, ensureThreadsJobs, getThreadsJob, processThreadsBatch, queueThreadsOnApproval,
  retryThreadsJob, serveThreadsMedia, threadsReleasePlan,
} from "../src/threads-publish.ts";
import type { Env } from "../src/env.ts";
import type { Session } from "../src/session.ts";

let worker: Miniflare;
let db: D1Database;
const realFetch = globalThis.fetch;
const APP_ID = "123456789";
const APP_SECRET = "test-only-threads-app-secret";
const USER = "17841400000000077";
const IMG = (n: number) => `https://raw.githubusercontent.com/GoofySpook/GSImageLibrary/main/test/${n}.png`;
const env = (extra: Partial<Env> = {}) => ({ DB: db, THREADS_APP_ID: APP_ID, THREADS_APP_SECRET: APP_SECRET,
  COOKIE_SECRET: "test-only-cookie-secret-for-threads", ...extra }) as Env;
const session: Session = { login: "gsgrimoire", raw: "test-session-raw-value" } as Session;

interface Call { method: string; path: string; params: URLSearchParams }
let calls: Call[] = [];
let accountId = USER;
let status = "FINISHED";
let publishFails = false;
let nextId = 0;
let holdPublish: (() => Promise<void>) | undefined;
let renewFails = false;
/** A pause for one mocked call: `reached` resolves when it is waiting, `release` lets it go on. */
function gate() {
  let release!: () => void, arrived!: () => void;
  const reached = new Promise<void>((r) => { arrived = r; });
  const open = new Promise<void>((r) => { release = r; });
  return { hold: () => { arrived(); return open; }, reached, release: () => release() };
}

before(async () => {
  worker = new Miniflare(convertV4MiniflareOptions({ modules: true, cf: false,
    script: "export default { fetch() { return new Response('threads tests'); } };",
    compatibilityDate: "2026-09-01", d1Databases: ["DB"] }));
  db = await worker.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
  await ensureThreadsSchema(db);
  await ensureThreadsJobs(db);
});
after(async () => { await worker?.dispose(); });
beforeEach(async () => {
  for (const t of ["threads_jobs", "threads_media_grants", "threads_targets", "threads_accounts", "threads_oauth_states",
    "instagram_targets", "bluesky_targets", "posts", "audit"]) await db.prepare(`DELETE FROM ${t}`).run();
  calls = []; accountId = USER; status = "FINISHED"; publishFails = false; nextId = 0; holdPublish = undefined; renewFails = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    assert.equal(url.hostname, "graph.threads.net", "no unexpected network request: " + url.href);
    assert.equal(init?.redirect, "manual", "Threads requests never follow redirects");
    const method = init?.method ?? "GET";
    const params = method === "POST" ? new URLSearchParams(init!.body as URLSearchParams) : url.searchParams;
    const path = url.pathname;
    calls.push({ method, path, params });
    if (path === "/oauth/access_token") return Response.json({ access_token: "short-lived-test-token", user_id: accountId });
    if (path === "/access_token") return Response.json({ access_token: "long-lived-test-token", token_type: "bearer", expires_in: 60 * 86400 });
    if (path === "/refresh_access_token" && renewFails) throw new TypeError("network connection lost");
    if (path === "/refresh_access_token") return Response.json({ access_token: "renewed-test-token", token_type: "bearer", expires_in: 60 * 86400 });
    if (path === "/v1.0/me") return Response.json({ id: accountId, username: "gsgrimoire" });
    if (method === "POST" && path === `/v1.0/${USER}/threads`) return Response.json({ id: "th-container-" + ++nextId });
    if (method === "POST" && path === `/v1.0/${USER}/threads_publish`) {
      const pause = holdPublish; holdPublish = undefined;
      if (pause) await pause();
      if (publishFails) throw new TypeError("network connection lost");
      return Response.json({ id: "th-post-1" });
    }
    if (method === "GET" && path.startsWith("/v1.0/th-container-")) return Response.json({ status });
    if (method === "GET" && path === "/v1.0/th-post-1") return Response.json({ permalink: "https://www.threads.net/@gsgrimoire/post/test" });
    return Response.json({ error: { message: "unexpected " + method + " " + path } }, { status: 500 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function connect() {
  const link = await beginThreadsConnection(env(), session);
  const req = new Request(`https://gs-poster.test/threads/callback?code=test-code%23_&state=${link.state}`,
    { headers: { Cookie: `${THREADS_STATE_COOKIE}=${link.state}` } });
  return finishThreadsConnection(env(), session, req);
}
function editorDraft(p: any): EditorDraft {
  return { message: p.message, tiktok_caption: null, images: p.images, tiktok_images: p.tiktok_images, video: null, tiktok_video: null,
    facebook_enabled: true, tiktok_enabled: false, scheduled_at: null, label: p.label, release: p.release, threads_enabled: true } as EditorDraft;
}
async function draft(th: ThreadsDraft, ig?: InstagramDraft) {
  const p = await createPost(db, { message: "Cave. Free in the Archive.", label: "Cave", release: null,
    images: [IMG(1), IMG(2), IMG(3)], video: null, created_by: "test", scheduled_at: null } as any);
  assert.ok(await saveEditorDraft(db, p.id, p.updated_at, editorDraft(p), null, ig, th));
  return (await getPost(db, p.id))!;
}
const sign = (payload: object, secret = APP_SECRET) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return createHmac("sha256", secret).update(body).digest("base64url") + "." + body;
};
const graphPosts = (suffix: string) => calls.filter((c) => c.method === "POST" && c.path.endsWith(suffix));

test("the token is encrypted at rest and only the right key opens it", async () => {
  const sealed = await sealThreadsToken(env(), "secret-token-value");
  assert.doesNotMatch(sealed, /secret-token-value/);
  assert.equal(await unsealThreadsToken(env(), sealed), "secret-token-value");
  await assert.rejects(unsealThreadsToken(env({ COOKIE_SECRET: "another-cookie-secret" }), sealed));
});

test("sign-in: hashed one-use state bound to the browser and session, then a stored encrypted long-lived token", async () => {
  const link = await beginThreadsConnection(env(), session);
  const u = new URL(link.url);
  assert.equal(u.host, "threads.net");
  assert.equal(u.searchParams.get("client_id"), APP_ID);
  assert.equal(u.searchParams.get("scope"), "threads_basic,threads_content_publish");
  assert.equal(u.searchParams.get("redirect_uri"), "https://gs-poster.goofyspook.workers.dev/threads/callback");
  const stored = await db.prepare("SELECT state_hash FROM threads_oauth_states").first<{ state_hash: string }>();
  assert.notEqual(stored?.state_hash, link.state, "state is stored only as a hash");
  const callback = (cookie: string, who = session) => finishThreadsConnection(env(), who,
    new Request(`https://gs-poster.test/threads/callback?code=test-code%23_&state=${link.state}`, { headers: { Cookie: `${THREADS_STATE_COOKIE}=${cookie}` } }));
  await assert.rejects(callback("other-browser"), /different browser/);
  await assert.rejects(callback(link.state, { login: "gsgrimoire", raw: "another-session" } as Session), /expired or was already used/);
  // Neither refused attempt consumed the state, so the right browser and session can still finish.
  const conn = await callback(link.state);
  assert.equal(conn.user_id, USER);
  assert.equal(conn.username, "gsgrimoire");
  const row = await db.prepare("SELECT token_cipher FROM threads_accounts").first<{ token_cipher: string }>();
  assert.doesNotMatch(row!.token_cipher, /long-lived-test-token/);
  const exchange = calls.find((c) => c.path === "/oauth/access_token")!;
  assert.equal(exchange.params.get("code"), "test-code", "Threads' trailing #_ is removed");
  assert.equal(exchange.params.get("client_secret"), APP_SECRET);
  await assert.rejects(callback(link.state), /expired or was already used/, "a state works once");
});

test("a second account is refused while one is connected", async () => {
  await connect();
  accountId = "17841400000000099";
  await assert.rejects(connect(), /Another Threads account/);
  assert.equal((await threadsConnection(db))!.user_id, USER);
});

test("renewal waits a day, then renews before expiry under a lease", async () => {
  await connect();
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await renewThreadsToken(env(), now + 3600), "not-needed", "too young and far from expiry");
  assert.equal(await renewThreadsToken(env(), now + 50 * 86400), "renewed");
  const conn = (await threadsConnection(db))!;
  assert.ok(conn.expires_at > now + 100 * 86400);
  const row = await db.prepare("SELECT token_cipher, lease_id FROM threads_accounts").first<{ token_cipher: string; lease_id: string | null }>();
  assert.equal(await unsealThreadsToken(env(), row!.token_cipher), "renewed-test-token");
  assert.equal(row!.lease_id, null);
});

test("Meta's signed callbacks: a forged request changes nothing, a valid one removes only the stored sign-in", async () => {
  await connect();
  assert.equal(await verifySignedRequest(env(), sign({ algorithm: "HMAC-SHA256", user_id: USER }, "wrong-secret")), null);
  const forged = await threadsAccountCallback(new Request("https://gs-poster.test/threads/deauthorize", { method: "POST",
    body: new URLSearchParams({ signed_request: sign({ algorithm: "HMAC-SHA256", user_id: USER }, "wrong-secret") }) }), env(), "deauthorize");
  assert.equal(forged.status, 400);
  assert.ok(await threadsConnection(db));
  const del = await threadsAccountCallback(new Request("https://gs-poster.test/threads/delete", { method: "POST",
    body: new URLSearchParams({ signed_request: sign({ algorithm: "HMAC-SHA256", user_id: USER, issued_at: 1 }) }) }), env(), "delete");
  assert.equal(del.status, 200);
  const body = await del.json() as { url: string; confirmation_code: string };
  assert.match(body.confirmation_code, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(await threadsConnection(db), null);
  const get = await threadsAccountCallback(new Request("https://gs-poster.test/threads/delete"), env(), "delete");
  assert.equal(get.status, 405);
});

test("the plan needs a connection and checks the text and photos", async () => {
  const p = await draft({ caption: "Into the cave #dnd", media: "none" });
  const off = await threadsReleasePlan(env(), p, null);
  assert.equal(off.ok === false && off.offered, false);
  await connect();
  assert.deepEqual(await threadsReleasePlan(env(), p, null), { ok: true, kind: "TEXT", count: 0, text: "Into the cave #dnd" });
  const long = await draft({ caption: "x".repeat(501), media: "none" });
  assert.match((await threadsReleasePlan(env(), long, null) as { reason: string }).reason, /over 500/);
  const fb = await draft({ caption: "Photos", media: "facebook" });
  assert.deepEqual(await threadsReleasePlan(env(), fb, null), { ok: true, kind: "CAROUSEL", count: 3, text: "Photos" });
  const reel = await draft({ caption: "Reel", media: "instagram" }, { caption: "r", frame: "4:5", items: [], video: IMG(9) });
  assert.match((await threadsReleasePlan(env(), reel, null) as { reason: string }).reason, /Reel/);
  const dash = await draft({ caption: "Into the cave — now", media: "none" });
  assert.equal((await threadsReleasePlan(env(), dash, null)).ok, false, "house rules apply");
});

test("a text post publishes once after processing, and a carousel uses the frozen Instagram frames", async () => {
  await connect();
  const p = await draft({ caption: "Into the cave", media: "none" });
  await queueThreadsOnApproval(env(), p.id, p.updated_at, new Date(Date.now() - 1000), "gsgrimoire");
  await processThreadsBatch(env());
  assert.equal(graphPosts("/threads")[0].params.get("media_type"), "TEXT");
  assert.equal(graphPosts("/threads")[0].params.get("text"), "Into the cave");
  await processThreadsBatch(env());
  assert.equal(graphPosts("/threads_publish").length, 1);
  const done = (await getThreadsJob(db, p.id))!;
  assert.equal(done.status, "published");
  assert.equal(done.permalink, "https://www.threads.net/@gsgrimoire/post/test");
  await processThreadsBatch(env());
  assert.equal(graphPosts("/threads_publish").length, 1, "never twice");

  calls = [];
  const ig: InstagramDraft = { caption: "IG", frame: "1:1", items: [defaultItem(IMG(1)), defaultItem(IMG(2), "pad")] };
  const q = await draft({ caption: "Two photos", media: "instagram" }, ig);
  await queueThreadsOnApproval(env(), q.id, q.updated_at, new Date(Date.now() - 1000), "gsgrimoire");
  const job = (await getThreadsJob(db, q.id))!;
  assert.equal(job.kind, "CAROUSEL");
  assert.equal(job.frame, "1:1");
  assert.equal(job.items[1].ig?.mode, "pad", "the Instagram crop/pad settings are frozen with the job");
  await processThreadsBatch(env());
  const media = graphPosts("/threads");
  assert.equal(media.length, 3);
  assert.equal(media[0].params.get("is_carousel_item"), "true");
  assert.match(media[0].params.get("image_url")!, /\/threads\/media\/[A-Za-z0-9_-]{32,90}\.jpg$/);
  assert.equal(media[2].params.get("media_type"), "CAROUSEL");
  assert.equal(media[2].params.get("children"), "th-container-2,th-container-3");
  // Every Threads call carries the decrypted token only inside the request to graph.threads.net.
  assert.ok(calls.every((c) => c.params.get("access_token") === "long-lived-test-token"));
});

test("an unclear final send is never resent and needs the owner's check to close", async () => {
  await connect();
  const p = await draft({ caption: "Into the cave", media: "none" });
  await queueThreadsOnApproval(env(), p.id, p.updated_at, new Date(Date.now() - 1000), "gsgrimoire");
  await processThreadsBatch(env());
  publishFails = true;
  await processThreadsBatch(env());
  const job = (await getThreadsJob(db, p.id))!;
  assert.equal(job.status, "failed");
  assert.equal(job.ambiguous, true);
  publishFails = false;
  await processThreadsBatch(env(), new Date(Date.now() + 600_000));
  assert.equal(graphPosts("/threads_publish").length, 1);
  assert.equal(await retryThreadsJob(env(), p.id, "gsgrimoire"), false);
  assert.equal(await closeAmbiguousThreadsJob(env(), p.id, "gsgrimoire"), true);
});

test("a disconnected account stops publishing before anything is sent", async () => {
  await connect();
  const p = await draft({ caption: "Into the cave", media: "none" });
  await queueThreadsOnApproval(env(), p.id, p.updated_at, new Date(Date.now() - 1000), "gsgrimoire");
  await disconnectThreads(db);
  await processThreadsBatch(env());
  assert.equal(graphPosts("/threads").length, 0);
  const job = (await getThreadsJob(db, p.id))!;
  assert.equal(job.status, "failed");
  assert.equal(job.ambiguous, false);
  assert.match(job.error!, /No Threads account/);
});

test("media links work only while their job is active", async () => {
  await connect();
  const p = await draft({ caption: "One photo", media: "facebook" });
  await db.prepare("UPDATE posts SET images = ? WHERE id = ?").bind(JSON.stringify([IMG(1)]), p.id).run();
  const q = (await getPost(db, p.id))!;
  await queueThreadsOnApproval(env(), q.id, q.updated_at, new Date(Date.now() - 1000), "gsgrimoire");
  await processThreadsBatch(env());
  const link = graphPosts("/threads")[0].params.get("image_url")!;
  const head = await serveThreadsMedia(new Request("https://gs-poster.test" + new URL(link).pathname, { method: "HEAD" }), env());
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "image/jpeg");
  assert.equal((await serveThreadsMedia(new Request("https://gs-poster.test/threads/media/" + "c".repeat(43) + ".jpg"), env())).status, 404);
  await processThreadsBatch(env());
  assert.equal((await getThreadsJob(db, q.id))!.status, "published");
  const after = await serveThreadsMedia(new Request("https://gs-poster.test" + new URL(link).pathname, { method: "HEAD" }), env());
  assert.equal(after.status, 404);
});

// ---------------------------------------------------------------- the #83 review fixes, applied to Threads

const queued = async (th: ThreadsDraft = { caption: "Into the cave", media: "none" }, at = new Date(Date.now() - 1000)) => {
  const p = await draft(th);
  await queueThreadsOnApproval(env(), p.id, p.updated_at, at, "gsgrimoire");
  return p;
};

test("the PIN-free draft deletion cannot remove a post with an approved Threads job", async () => {
  const { handleDeleteDraft } = await import("../src/mcp.ts");
  const { cancelThreadsJob } = await import("../src/threads-publish.ts");
  await connect();
  const editor = env({ ALLOWED_GITHUB_LOGINS: "gsgrimoire" });
  for (const state of ["scheduled", "preparing", "processing", "sending", "failed", "published"]) {
    const p = await queued(undefined, new Date(Date.now() + 3600_000));
    await db.prepare("UPDATE threads_jobs SET status = ? WHERE post_id = ?").bind(state, p.id).run();
    const res = await handleDeleteDraft(editor, "gsgrimoire", p.id);
    assert.match(JSON.stringify(res), /approved this post for Threads/, state);
    assert.ok(await getPost(db, p.id), state);
  }
  const c = await queued(undefined, new Date(Date.now() + 3600_000));
  assert.equal(await cancelThreadsJob(env(), c.id, "gsgrimoire"), true);
  assert.equal(JSON.parse((await handleDeleteDraft(editor, "gsgrimoire", c.id) as any).content[0].text).deleted, c.id);
});

test("a calendar move carries a waiting Threads job in the same transaction, and is refused once it has started", async () => {
  const { updateCalendarTime } = await import("../src/db.ts");
  const { reschedulePost } = await import("../src/publish.ts");
  await connect();
  const p = await queued(undefined, new Date(Date.now() + 3600_000));
  const later = new Date(Date.now() + 2 * 86400_000).toISOString();
  assert.equal(await updateCalendarTime(db, p.id, later, (await getPost(db, p.id))!.updated_at, false), true);
  assert.equal((await getThreadsJob(db, p.id))!.due_at, later);
  await db.prepare("UPDATE threads_jobs SET status = 'preparing' WHERE post_id = ?").bind(p.id).run();
  const cur = (await getPost(db, p.id))!;
  await assert.rejects(reschedulePost(env(), p.id, new Date(Date.now() + 3 * 86400_000), cur.updated_at, "gsgrimoire"), /Threads has started/);
  assert.equal(await updateCalendarTime(db, p.id, new Date(Date.now() + 4 * 86400_000).toISOString(), cur.updated_at, false), false);
  assert.equal((await getPost(db, p.id))!.scheduled_at, later);
  assert.equal((await getThreadsJob(db, p.id))!.due_at, later);
});

test("an interrupted Threads send becomes an unclear result, never a resend", async () => {
  await connect();
  const p = await queued();
  await processThreadsBatch(env());
  await db.prepare("UPDATE threads_jobs SET status = 'sending', lease_until = ? WHERE post_id = ?")
    .bind(new Date(Date.now() - 1000).toISOString(), p.id).run();
  await processThreadsBatch(env());
  const job = (await getThreadsJob(db, p.id))!;
  assert.equal(job.status, "failed");
  assert.equal(job.ambiguous, true);
  assert.match(job.error!, /interrupted/);
  assert.equal(graphPosts("/threads_publish").length, 0);
});

test("a late Threads answer records the post only while the owner has not decided", async () => {
  await connect();
  for (const ownerClosesFirst of [false, true]) {
    calls = [];
    const p = await queued();
    await processThreadsBatch(env());
    const g = gate();
    holdPublish = g.hold;
    const slow = processThreadsBatch(env());
    await g.reached;
    await processThreadsBatch(env(), new Date(Date.now() + 11 * 60_000));
    assert.equal((await getThreadsJob(db, p.id))!.ambiguous, true);
    if (ownerClosesFirst) assert.equal(await closeAmbiguousThreadsJob(env(), p.id, "gsgrimoire"), true);
    g.release();
    await slow;
    const job = (await getThreadsJob(db, p.id))!;
    assert.equal(job.status, ownerClosesFirst ? "cancelled" : "published");
    if (!ownerClosesFirst) assert.equal(job.media_id, "th-post-1");
    assert.equal(graphPosts("/threads_publish").length, 1);
  }
});

test("if saving the returned Threads post id fails, the job is unclear and shows that id", async () => {
  await connect();
  const p = await queued();
  await processThreadsBatch(env());
  const failing = new Proxy(db, { get(target, prop) {
    if (prop === "prepare") return (sql: string) => {
      if (/SET media_id = \?/.test(sql)) return { bind: () => ({ run: async () => { throw new Error("D1 write failed"); } }) };
      return target.prepare(sql);
    };
    const v = (target as any)[prop];
    return typeof v === "function" ? v.bind(target) : v;
  } }) as D1Database;
  await processThreadsBatch(env({ DB: failing }));
  const job = (await getThreadsJob(db, p.id))!;
  assert.equal(job.ambiguous, true);
  assert.match(job.error!, /returned post id th-post-1/);
});

test("F4 for Threads: an approved Threads post's time and switch are frozen against PIN-free edits and rejection", async () => {
  const { saveEditorDraft: save, rejectDraft } = await import("../src/db.ts");
  const { handleUpdateDraft } = await import("../src/mcp.ts");
  const { cancelThreadsJob } = await import("../src/threads-publish.ts");
  await connect();
  const at = new Date(Date.now() + 2 * 86400_000);
  const p = await queued(undefined, at);
  const cur = (await getPost(db, p.id))!;
  const base = { ...editorDraft(cur), tiktok_title: null, instagram_enabled: false, bluesky_enabled: false };
  assert.equal(await save(db, p.id, cur.updated_at, { ...base, scheduled_at: new Date(Date.now() + 86400_000).toISOString() }, null), null);
  assert.equal(await save(db, p.id, cur.updated_at, { ...base, threads_enabled: false }, null, undefined, cur.threads), null);
  assert.equal(await rejectDraft(db, p.id, "no"), false);
  const editor = env({ ALLOWED_GITHUB_LOGINS: "gsgrimoire", TIMEZONE: "Europe/Copenhagen" });
  assert.match(JSON.stringify(await handleUpdateDraft(editor, "https://gs-poster.test", "gsgrimoire", { id: p.id, publish_at: "2030-01-01T18:00" } as any)), /time is locked/);
  assert.match(JSON.stringify(await handleUpdateDraft(editor, "https://gs-poster.test", "gsgrimoire", { id: p.id, threads: null } as any)), /cannot be switched off/);
  const text = await handleUpdateDraft(editor, "https://gs-poster.test", "gsgrimoire", { id: p.id, message: "Edited caption." } as any);
  assert.equal(JSON.parse((text as any).content[0].text).saved, true);
  const job = (await getThreadsJob(db, p.id))!;
  assert.equal(job.due_at, at.toISOString());
  assert.equal(job.text, "Into the cave", "the approved text is frozen");
  assert.equal(await cancelThreadsJob(env(), p.id, "gsgrimoire"), true);
  assert.equal(await rejectDraft(db, p.id, "no"), true, "after the PIN cancel the draft can be rejected");
});

test("T2: a failed token renewal does not hold back a due post while the sign-in is still valid", async () => {
  const { runThreadsCron } = await import("../src/threads-publish.ts");
  await connect();
  // Ten days left and older than a day: inside the renewal window.
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("UPDATE threads_accounts SET issued_at = ?, expires_at = ?").bind(now - 50 * 86400, now + 10 * 86400).run();
  const p = await queued();
  renewFails = true;
  await assert.rejects(runThreadsCron(env()), /network connection lost/, "the cron run is still reported as failed");
  assert.equal(graphPosts("/threads").length, 1, "the due post was processed with the existing token");
  assert.equal((await getThreadsJob(db, p.id))!.status, "processing");
  const log = await db.prepare("SELECT 1 AS x FROM audit WHERE action = 'threads-renewal-failed'").first();
  assert.ok(log, "the renewal failure is in the activity log");
  renewFails = false;
  await runThreadsCron(env());
  assert.equal((await getThreadsJob(db, p.id))!.status, "published");
  assert.ok((await threadsConnection(db))!.expires_at > now + 50 * 86400, "renewal succeeds on a later run");
});
