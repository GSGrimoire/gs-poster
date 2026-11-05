// Approved Instagram publishing: approval freezing, cron state machine, the
// one-way sending barrier, PIN-gated recovery and the short-lived media links.
// Real D1 in workerd; every Meta call goes to an in-process mock. No real
// network request, account, token or PIN is used.
import { before, beforeEach, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createPost, ensureSchema, getPost, saveEditorDraft, type EditorDraft } from "../src/db.ts";
import { defaultItem, type InstagramDraft } from "../src/instagram.ts";
import {
  cancelInstagramJob, closeAmbiguousInstagramJob, ensureInstagramJobs, getInstagramJob, instagramReleasePlan,
  processInstagramBatch, queueInstagramOnApproval, retryInstagramJob, serveInstagramMedia, cancelScheduledInstagram,
} from "../src/instagram-publish.ts";
import type { Env } from "../src/env.ts";

let worker: Miniflare;
let db: D1Database;
const realFetch = globalThis.fetch;
const IG_ID = "17841400000000001";
const IMG = (n: number) => `https://raw.githubusercontent.com/GoofySpook/GSImageLibrary/main/test/${n}.png`;
const VIDEO = "https://raw.githubusercontent.com/GoofySpook/GSImageLibrary/main/test/reel.mp4";
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0, 105, 115, 111, 109, 105, 115, 111, 50]);

interface GraphCall { method: string; path: string; body: URLSearchParams }
let calls: GraphCall[] = [];
let status = "FINISHED";
let publishFails = false;
let containerFails = false;
let holdContainer: (() => Promise<void>) | undefined;
let holdPublish: (() => Promise<void>) | undefined;
let nextId = 0;

before(async () => {
  worker = new Miniflare(convertV4MiniflareOptions({ modules: true, cf: false,
    script: "export default { fetch() { return new Response('instagram tests'); } };",
    compatibilityDate: "2026-09-01", d1Databases: ["DB"] }));
  db = await worker.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
  await ensureInstagramJobs(db);
});
after(async () => { await worker?.dispose(); });
beforeEach(async () => {
  for (const t of ["instagram_jobs", "instagram_media_grants", "instagram_targets", "bluesky_targets", "posts", "audit"])
    await db.prepare(`DELETE FROM ${t}`).run();
  calls = []; status = "FINISHED"; publishFails = false; containerFails = false; holdContainer = undefined; holdPublish = undefined; nextId = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "raw.githubusercontent.com") return new Response(MP4);
    assert.equal(url.hostname, "graph.facebook.com", "no unexpected network request: " + url.href);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v[0-9.]+\//, "");
    const body = method === "POST" ? new URLSearchParams(init!.body as URLSearchParams) : url.searchParams;
    calls.push({ method, path, body });
    if (method === "POST" && path === `${IG_ID}/media`) {
      if (containerFails) return Response.json({ error: { message: "Media URL could not be fetched" } }, { status: 400 });
      const pause = holdContainer; holdContainer = undefined;
      if (pause) await pause();
      return Response.json({ id: "container-" + ++nextId });
    }
    if (method === "POST" && path === `${IG_ID}/media_publish`) {
      const pause = holdPublish; holdPublish = undefined;
      if (pause) await pause();
      if (publishFails) throw new TypeError("network connection lost");
      return Response.json({ id: "ig-media-1" });
    }
    if (method === "GET" && path.startsWith("container-")) return Response.json({ status_code: status });
    if (method === "GET" && path === "ig-media-1") return Response.json({ permalink: "https://www.instagram.com/p/test/" });
    if (method === "GET" && path === IG_ID) return Response.json({ username: "gsgrimoire" });
    return Response.json({ error: { message: "unexpected " + method + " " + path } }, { status: 500 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const env = (extra: Partial<Env> = {}) =>
  ({ DB: db, FB_PAGE_ID: "123", FB_PAGE_TOKEN: "test-only-token", IG_USER_ID: IG_ID, ...extra }) as Env;

function editorDraft(p: any): EditorDraft {
  return { message: p.message, tiktok_caption: null, images: p.images, tiktok_images: p.tiktok_images, video: null,
    tiktok_video: null, facebook_enabled: true, tiktok_enabled: false, scheduled_at: null, label: p.label, release: p.release };
}
async function draft(ig: InstagramDraft) {
  const p = await createPost(db, { message: "Cave. Free in the Archive.", label: "Cave", release: null,
    images: [IMG(1), IMG(2), IMG(3)], video: null, created_by: "test", scheduled_at: null } as any);
  const version = await saveEditorDraft(db, p.id, p.updated_at, editorDraft(p), null, ig);
  assert.ok(version);
  return (await getPost(db, p.id))!;
}
const CAROUSEL: InstagramDraft = { caption: "Into the cave #dnd", frame: "4:5", items: [defaultItem(IMG(1)), defaultItem(IMG(2)), defaultItem(IMG(3))] };
const REEL: InstagramDraft = { caption: "Watch #dnd", frame: "4:5", items: [], video: VIDEO };
const due = new Date(Date.now() - 1000);
/** A pause for one mocked Meta call: `reached` resolves when the call is waiting, `release` lets it go on. */
function gate() {
  let release!: () => void, arrived!: () => void;
  const reached = new Promise<void>((r) => { arrived = r; });
  const open = new Promise<void>((r) => { release = r; });
  return { hold: () => { arrived(); return open; }, reached, release: () => release() };
}
const mediaPosts = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/media"));
const publishes = () => calls.filter((c) => c.path.endsWith("/media_publish"));

test("the release plan stays manual until Instagram is connected, and checks the content", async () => {
  const p = await draft(CAROUSEL);
  const off = instagramReleasePlan(env({ IG_USER_ID: undefined }), p, null);
  assert.equal(off.ok, false);
  assert.equal(off.ok === false && off.offered, false, "not offered before IG_USER_ID is set");
  const bad = instagramReleasePlan(env({ IG_USER_ID: "not-a-number" }), p, null);
  assert.equal(bad.ok, false);
  const ok = instagramReleasePlan(env(), p, null);
  assert.deepEqual(ok, { ok: true, kind: "CAROUSEL", count: 3, caption: CAROUSEL.caption });
  const both = instagramReleasePlan(env(), { instagram: { ...CAROUSEL, video: VIDEO } }, null);
  assert.match(both.ok ? "" : both.reason, /either photos or a Reel/);
  const none = instagramReleasePlan(env(), { instagram: { ...CAROUSEL, items: [] } }, null);
  assert.match(none.ok ? "" : none.reason, /add photos or a Reel/);
});

test("approval freezes the approved content and is fenced on the reviewed version", async () => {
  const p = await draft(CAROUSEL);
  await assert.rejects(queueInstagramOnApproval(env(), p.id, "2020-01-01T00:00:00.000Z", due, "gsgrimoire"), /changed/);
  const job = await queueInstagramOnApproval(env(), p.id, p.updated_at, due, "gsgrimoire");
  assert.equal(job.status, "scheduled");
  assert.equal(job.items.length, 3);
  // Editing the draft afterwards does not change what was approved.
  const edited = await saveEditorDraft(db, p.id, p.updated_at, editorDraft(p), null, { ...CAROUSEL, caption: "Changed later", items: [defaultItem(IMG(1))] });
  assert.ok(edited);
  const frozen = (await getInstagramJob(db, p.id))!;
  assert.equal(frozen.caption, CAROUSEL.caption);
  assert.equal(frozen.items.length, 3);
  // A second approval while a job exists is refused.
  const again = (await getPost(db, p.id))!;
  await assert.rejects(queueInstagramOnApproval(env(), p.id, again.updated_at, due, "gsgrimoire"), /already has an approved job/);
  // After a cancel, a fresh approval may replace it.
  assert.equal(await cancelInstagramJob(env(), p.id, "gsgrimoire"), true);
  const replaced = await queueInstagramOnApproval(env(), p.id, again.updated_at, due, "gsgrimoire");
  assert.equal(replaced.caption, "Changed later");
});

test("a carousel publishes once, in order, after Meta finishes processing", async () => {
  const p = await draft(CAROUSEL);
  const future = new Date(Date.now() + 3600_000);
  await queueInstagramOnApproval(env(), p.id, p.updated_at, future, "gsgrimoire");
  await processInstagramBatch(env());
  assert.equal(calls.length, 0, "nothing before the approved time");
  await processInstagramBatch(env(), new Date(future.getTime() + 1000));
  const media = mediaPosts();
  assert.equal(media.length, 4, "three children and one carousel parent");
  for (const child of media.slice(0, 3)) {
    assert.equal(child.body.get("is_carousel_item"), "true");
    assert.match(child.body.get("image_url")!, /^https:\/\/gs-poster\.goofyspook\.workers\.dev\/instagram\/media\/[A-Za-z0-9_-]{32,90}\.jpg$/);
    assert.equal(child.body.get("caption"), null);
  }
  assert.equal(media[3].body.get("media_type"), "CAROUSEL");
  assert.equal(media[3].body.get("children"), "container-1,container-2,container-3");
  assert.equal(media[3].body.get("caption"), CAROUSEL.caption);
  assert.equal(publishes().length, 0, "publish waits for the processing check");
  assert.equal((await getInstagramJob(db, p.id))!.status, "processing");

  status = "IN_PROGRESS";
  await processInstagramBatch(env(), new Date(future.getTime() + 61_000));
  assert.equal(publishes().length, 0);
  status = "FINISHED";
  await processInstagramBatch(env(), new Date(future.getTime() + 122_000));
  assert.equal(publishes().length, 1);
  assert.equal(publishes()[0].body.get("creation_id"), "container-4");
  const job = (await getInstagramJob(db, p.id))!;
  assert.equal(job.status, "published");
  assert.equal(job.media_id, "ig-media-1");
  assert.equal(job.permalink, "https://www.instagram.com/p/test/");
  const before = calls.length;
  await processInstagramBatch(env(), new Date(future.getTime() + 300_000));
  assert.equal(calls.length, before, "a published job is never touched again");
  const grants = await db.prepare("SELECT COUNT(*) AS n FROM instagram_media_grants WHERE post_id = ?").bind(p.id).first<{ n: number }>();
  assert.equal(grants?.n, 0, "media links are removed after publishing");
});

test("a single photo is one container with its caption; a Reel uses a video link", async () => {
  const one = await draft({ ...CAROUSEL, items: [defaultItem(IMG(2))] });
  await queueInstagramOnApproval(env(), one.id, one.updated_at, due, "gsgrimoire");
  await processInstagramBatch(env());
  assert.equal(mediaPosts().length, 1);
  assert.equal(mediaPosts()[0].body.get("caption"), CAROUSEL.caption);
  assert.equal(mediaPosts()[0].body.get("is_carousel_item"), null);
  assert.ok(mediaPosts()[0].body.get("image_url"));

  calls = [];
  const reel = await draft(REEL);
  await queueInstagramOnApproval(env(), reel.id, reel.updated_at, due, "gsgrimoire");
  await processInstagramBatch(env());
  await processInstagramBatch(env());
  const reelMedia = mediaPosts().filter((c) => c.body.get("media_type") === "REELS");
  assert.equal(reelMedia.length, 1);
  assert.match(reelMedia[0].body.get("video_url")!, /\/instagram\/media\/[A-Za-z0-9_-]+\.mp4$/);
});

test("an unclear final send is never resent and needs the owner's check to close", async () => {
  const p = await draft({ ...CAROUSEL, items: [defaultItem(IMG(1))] });
  await queueInstagramOnApproval(env(), p.id, p.updated_at, due, "gsgrimoire");
  await processInstagramBatch(env());
  publishFails = true;
  await processInstagramBatch(env());
  assert.equal(publishes().length, 1);
  let job = (await getInstagramJob(db, p.id))!;
  assert.equal(job.status, "failed");
  assert.equal(job.ambiguous, true);
  assert.match(job.error!, /may or may not be on Instagram/);
  publishFails = false;
  for (let i = 0; i < 3; i++) await processInstagramBatch(env(), new Date(Date.now() + (i + 1) * 600_000));
  assert.equal(publishes().length, 1, "cron never resends after the barrier");
  assert.equal(await retryInstagramJob(env(), p.id, "gsgrimoire"), false, "plain retry is refused");
  assert.equal(await cancelInstagramJob(env(), p.id, "gsgrimoire"), false, "plain cancel is refused");
  assert.equal(await closeAmbiguousInstagramJob(env(), p.id, "gsgrimoire"), true);
  job = (await getInstagramJob(db, p.id))!;
  assert.equal(job.status, "cancelled");
  assert.equal(publishes().length, 1);
});

test("a failure before the final send can be retried with the PIN path", async () => {
  const p = await draft(CAROUSEL);
  await queueInstagramOnApproval(env(), p.id, p.updated_at, due, "gsgrimoire");
  containerFails = true;
  await processInstagramBatch(env());
  let job = (await getInstagramJob(db, p.id))!;
  assert.equal(job.status, "failed");
  assert.equal(job.ambiguous, false);
  assert.match(job.error!, /could not be fetched/);
  assert.equal(await closeAmbiguousInstagramJob(env(), p.id, "gsgrimoire"), false);
  containerFails = false;
  assert.equal(await retryInstagramJob(env(), p.id, "gsgrimoire"), true);
  job = (await getInstagramJob(db, p.id))!;
  assert.equal(job.status, "scheduled");
  assert.deepEqual(job.children, []);
  await processInstagramBatch(env());
  await processInstagramBatch(env());
  assert.equal((await getInstagramJob(db, p.id))!.status, "published");
  assert.equal(publishes().length, 1);
});

test("Reel processing errors fail without publishing, and a stalled one times out", async () => {
  const p = await draft(REEL);
  await queueInstagramOnApproval(env(), p.id, p.updated_at, due, "gsgrimoire");
  await processInstagramBatch(env());
  status = "ERROR";
  await processInstagramBatch(env());
  assert.equal((await getInstagramJob(db, p.id))!.status, "failed");
  assert.equal(publishes().length, 0);

  const q = await draft(REEL);
  await queueInstagramOnApproval(env(), q.id, q.updated_at, due, "gsgrimoire");
  status = "IN_PROGRESS";
  await processInstagramBatch(env());
  await processInstagramBatch(env(), new Date(Date.now() + 3 * 3600_000));
  const stalled = (await getInstagramJob(db, q.id))!;
  assert.equal(stalled.status, "failed");
  assert.match(stalled.error!, /two hours/);
  assert.equal(publishes().length, 0);
});

test("two overlapping cron runs cannot both work on one job", async () => {
  const p = await draft(CAROUSEL);
  await queueInstagramOnApproval(env(), p.id, p.updated_at, due, "gsgrimoire");
  const g = gate();
  holdContainer = g.hold;
  const first = processInstagramBatch(env());
  await g.reached;
  await processInstagramBatch(env());
  g.release();
  await first;
  assert.equal(mediaPosts().length, 4, "the second run found the job claimed and did nothing");
});

test("nothing runs when Instagram is not connected, and cancel follows the post", async () => {
  const p = await draft(CAROUSEL);
  await queueInstagramOnApproval(env(), p.id, p.updated_at, due, "gsgrimoire");
  await processInstagramBatch(env({ IG_USER_ID: undefined }));
  assert.equal(calls.length, 0);
  assert.equal(await cancelScheduledInstagram(db, p.id), true);
  await processInstagramBatch(env());
  assert.equal(calls.length, 0);
});

test("media links work only while their job is being prepared or sent", async () => {
  const p = await draft(REEL);
  await queueInstagramOnApproval(env(), p.id, p.updated_at, due, "gsgrimoire");
  await processInstagramBatch(env());
  const link = mediaPosts()[0].body.get("video_url")!;
  const path = new URL(link).pathname;
  const res = await serveInstagramMedia(new Request("https://gs-poster.test" + path), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), MP4);
  const wrongType = await serveInstagramMedia(new Request("https://gs-poster.test" + path.replace(".mp4", ".jpg")), env());
  assert.equal(wrongType.status, 404);
  const guessed = await serveInstagramMedia(new Request("https://gs-poster.test/instagram/media/" + "a".repeat(43) + ".mp4"), env());
  assert.equal(guessed.status, 404);
  const post = await serveInstagramMedia(new Request("https://gs-poster.test" + path, { method: "POST" }), env());
  assert.equal(post.status, 405);
  // Once published, the same link stops working.
  await processInstagramBatch(env());
  assert.equal((await getInstagramJob(db, p.id))!.status, "published");
  const after = await serveInstagramMedia(new Request("https://gs-poster.test" + path), env());
  assert.equal(after.status, 404);
});

test("a ten-photo carousel spreads its containers over runs, checkpointed, within the request budget", async () => {
  const items = Array.from({ length: 10 }, (_, i) => defaultItem(IMG(i + 1)));
  const p = await draft({ ...CAROUSEL, items });
  await queueInstagramOnApproval(env(), p.id, p.updated_at, due, "gsgrimoire");
  await processInstagramBatch(env());
  assert.equal(mediaPosts().length, 5, "first run: five photo containers");
  assert.deepEqual((await getInstagramJob(db, p.id))!.children, ["container-1", "container-2", "container-3", "container-4", "container-5"]);
  const before = calls.length;
  await processInstagramBatch(env());
  assert.ok(calls.length - before <= 6, "at most six outside requests in one run");
  const parent = mediaPosts().at(-1)!;
  assert.equal(parent.body.get("media_type"), "CAROUSEL");
  assert.equal(parent.body.get("children"), Array.from({ length: 10 }, (_, i) => "container-" + (i + 1)).join(","));
  await processInstagramBatch(env());
  assert.equal((await getInstagramJob(db, p.id))!.status, "published");
  assert.equal(publishes().length, 1);
});

test("the Instagram caption must pass the house rules before approval", async () => {
  const p = await draft({ ...CAROUSEL, caption: "Into the cave — now #dnd" });
  const plan = instagramReleasePlan(env(), p, null);
  assert.equal(plan.ok, false);
  await assert.rejects(queueInstagramOnApproval(env(), p.id, p.updated_at, due, "gsgrimoire"), /Fix in the Instagram card/);
  assert.equal(await getInstagramJob(db, p.id), null);
});

test("moving the post in the calendar moves a waiting Instagram job too", async () => {
  const { reschedulePost } = await import("../src/publish.ts");
  const p = await draft(CAROUSEL);
  await queueInstagramOnApproval(env(), p.id, p.updated_at, new Date(Date.now() + 3600_000), "gsgrimoire");
  const later = new Date(Date.now() + 2 * 86400_000);
  await reschedulePost(env(), p.id, later, (await getPost(db, p.id))!.updated_at, "gsgrimoire");
  assert.equal((await getInstagramJob(db, p.id))!.due_at, later.toISOString());
  await processInstagramBatch(env());
  assert.equal(calls.length, 0, "nothing goes out before the moved time");
});

// ---------------------------------------------------------------- review #83: F1 deletion

test("F1: the PIN-free draft deletion cannot remove a post with an approved Instagram job, in any state", async () => {
  const { handleDeleteDraft } = await import("../src/mcp.ts");
  const editor = env({ ALLOWED_GITHUB_LOGINS: "gsgrimoire" });
  const body = (r: any) => JSON.parse(r.content[0].text);
  // An unapproved draft can still be deleted.
  const plain = await createPost(db, { message: "Plain.", images: [], created_by: "test", scheduled_at: null } as any);
  assert.equal(body(await handleDeleteDraft(editor, "gsgrimoire", plain.id)).deleted, plain.id);
  for (const state of ["scheduled", "preparing", "processing", "sending", "failed-ambiguous", "failed", "published"]) {
    const p = await draft(CAROUSEL);
    await queueInstagramOnApproval(env(), p.id, p.updated_at, new Date(Date.now() + 3600_000), "gsgrimoire");
    const [status, ambiguous] = state === "failed-ambiguous" ? ["failed", 1] : [state, 0];
    await db.prepare("UPDATE instagram_jobs SET status = ?, ambiguous = ? WHERE post_id = ?").bind(status, ambiguous, p.id).run();
    const res = await handleDeleteDraft(editor, "gsgrimoire", p.id);
    assert.equal((res as any).isError, true, state);
    assert.match(JSON.stringify(res), /approved this post for Instagram/, state);
    assert.ok(await getPost(db, p.id), "the post is kept: " + state);
    assert.equal((await getInstagramJob(db, p.id))!.status, status, "the job is untouched: " + state);
  }
  // After the owner's PIN-gated cancel, the draft may go.
  const c = await draft(CAROUSEL);
  await queueInstagramOnApproval(env(), c.id, c.updated_at, new Date(Date.now() + 3600_000), "gsgrimoire");
  assert.equal(await cancelInstagramJob(env(), c.id, "gsgrimoire"), true);
  assert.equal(body(await handleDeleteDraft(editor, "gsgrimoire", c.id)).deleted, c.id);
});

test("F1: a cron claim and a deletion racing each other never leave a claimed job without its post", async () => {
  const { handleDeleteDraft } = await import("../src/mcp.ts");
  const p = await draft(CAROUSEL);
  await queueInstagramOnApproval(env(), p.id, p.updated_at, due, "gsgrimoire");
  const g = gate();
  holdContainer = g.hold;
  const run = processInstagramBatch(env());
  await g.reached;
  const res = await handleDeleteDraft(env({ ALLOWED_GITHUB_LOGINS: "gsgrimoire" }), "gsgrimoire", p.id);
  assert.equal((res as any).isError, true);
  g.release();
  await run;
  assert.ok(await getPost(db, p.id));
  assert.equal((await getInstagramJob(db, p.id))!.status, "processing");
});

// ---------------------------------------------------------------- review #83: F2 calendar moves

test("F2: a calendar move is refused, with nothing changed, once Instagram has started", async () => {
  const { reschedulePost } = await import("../src/publish.ts");
  const { updateCalendarTime } = await import("../src/db.ts");
  const p = await draft(CAROUSEL);
  const first = new Date(Date.now() + 3600_000);
  await queueInstagramOnApproval(env(), p.id, p.updated_at, first, "gsgrimoire");
  // Cron claims the job just before the move.
  await db.prepare("UPDATE instagram_jobs SET status = 'preparing' WHERE post_id = ?").bind(p.id).run();
  const cur = (await getPost(db, p.id))!;
  await assert.rejects(reschedulePost(env(), p.id, new Date(Date.now() + 2 * 86400_000), cur.updated_at, "gsgrimoire"),
    /Instagram has started/);
  // The same guard sits inside the transaction itself, for a claim that lands after any read.
  assert.equal(await updateCalendarTime(db, p.id, new Date(Date.now() + 3 * 86400_000).toISOString(), cur.updated_at, false), false);
  const after = (await getPost(db, p.id))!;
  assert.equal(after.scheduled_at, cur.scheduled_at, "the post's time is unchanged");
  assert.equal(after.updated_at, cur.updated_at);
  assert.equal((await getInstagramJob(db, p.id))!.due_at, first.toISOString(), "the job's time is unchanged");
});

test("F2: an approved mixed schedule is refused before Facebook is touched once Instagram has started", async () => {
  const { reschedulePost } = await import("../src/publish.ts");
  const p = await draft(CAROUSEL);
  await queueInstagramOnApproval(env(), p.id, p.updated_at, new Date(Date.now() + 86400_000), "gsgrimoire");
  const at = new Date(Date.now() + 86400_000).toISOString();
  await db.prepare("UPDATE posts SET status = 'scheduled', approved_at = ?, scheduled_at = ?, fb_post_id = '123_456' WHERE id = ?")
    .bind(new Date().toISOString(), at, p.id).run();
  await db.prepare("UPDATE instagram_jobs SET status = 'processing' WHERE post_id = ?").bind(p.id).run();
  const cur = (await getPost(db, p.id))!;
  await assert.rejects(reschedulePost(env(), p.id, new Date(Date.now() + 2 * 86400_000), cur.updated_at, "gsgrimoire"),
    /Instagram has started/);
  assert.equal(calls.length, 0, "no Facebook call was made");
  assert.equal((await getPost(db, p.id))!.scheduled_at, at);
});

test("F2: a waiting Instagram job moves in the same transaction as the post", async () => {
  const { updateCalendarTime } = await import("../src/db.ts");
  const p = await draft(CAROUSEL);
  await queueInstagramOnApproval(env(), p.id, p.updated_at, new Date(Date.now() + 3600_000), "gsgrimoire");
  const later = new Date(Date.now() + 2 * 86400_000).toISOString();
  // A stale version moves neither.
  assert.equal(await updateCalendarTime(db, p.id, later, "2020-01-01T00:00:00.000Z", false), false);
  assert.notEqual((await getInstagramJob(db, p.id))!.due_at, later);
  assert.equal(await updateCalendarTime(db, p.id, later, (await getPost(db, p.id))!.updated_at, false), true);
  assert.equal((await getInstagramJob(db, p.id))!.due_at, later);
  assert.equal((await getPost(db, p.id))!.scheduled_at, later);
});

// ---------------------------------------------------------------- review #83: F3 interrupted sends

async function readyToSend() {
  const p = await draft({ ...CAROUSEL, items: [defaultItem(IMG(1))] });
  await queueInstagramOnApproval(env(), p.id, p.updated_at, due, "gsgrimoire");
  await processInstagramBatch(env());
  assert.equal((await getInstagramJob(db, p.id))!.status, "processing");
  return p;
}

test("F3: a send interrupted right after the barrier becomes an unclear result for the owner, never a resend", async () => {
  const p = await readyToSend();
  await db.prepare("UPDATE instagram_jobs SET status = 'sending', lease_until = ? WHERE post_id = ?")
    .bind(new Date(Date.now() - 1000).toISOString(), p.id).run();
  await processInstagramBatch(env());
  const job = (await getInstagramJob(db, p.id))!;
  assert.equal(job.status, "failed");
  assert.equal(job.ambiguous, true);
  assert.match(job.error!, /interrupted/);
  assert.equal(publishes().length, 0, "nothing was sent again");
  assert.equal(await retryInstagramJob(env(), p.id, "gsgrimoire"), false);
  assert.equal(await closeAmbiguousInstagramJob(env(), p.id, "gsgrimoire"), true);
});

test("F3: a send still inside its lease is left alone", async () => {
  const p = await readyToSend();
  await db.prepare("UPDATE instagram_jobs SET status = 'sending', lease_until = ? WHERE post_id = ?")
    .bind(new Date(Date.now() + 600_000).toISOString(), p.id).run();
  await processInstagramBatch(env());
  assert.equal((await getInstagramJob(db, p.id))!.status, "sending");
  assert.equal(publishes().length, 0);
});

test("F3: a late answer records the real post while the owner has not decided, and never undoes their decision", async () => {
  for (const ownerClosesFirst of [false, true]) {
    calls = [];
    const p = await readyToSend();
    const g = gate();
    holdPublish = g.hold;
    const slow = processInstagramBatch(env());
    await g.reached;
    // A later cron run finds the send lease expired and marks it unclear.
    await processInstagramBatch(env(), new Date(Date.now() + 11 * 60_000));
    assert.equal((await getInstagramJob(db, p.id))!.ambiguous, true);
    if (ownerClosesFirst) assert.equal(await closeAmbiguousInstagramJob(env(), p.id, "gsgrimoire"), true);
    g.release();
    await slow;
    const job = (await getInstagramJob(db, p.id))!;
    if (ownerClosesFirst) {
      assert.equal(job.status, "cancelled", "the owner's decision stands");
      const log = await db.prepare("SELECT detail FROM audit WHERE post_id = ? AND action = 'instagram-late-result-after-owner-decision'").bind(p.id).first<{ detail: string }>();
      assert.equal(log?.detail, "ig-media-1", "the late post id is kept in the activity log");
    } else {
      assert.equal(job.status, "published");
      assert.equal(job.media_id, "ig-media-1");
      assert.equal(job.ambiguous, false);
    }
    assert.equal(publishes().length, 1, "exactly one publish request");
  }
});

test("F3: if saving the returned post id fails, the job is unclear and shows that id", async () => {
  const p = await readyToSend();
  const failing = new Proxy(db, { get(target, prop) {
    if (prop === "prepare") return (sql: string) => {
      if (/SET media_id = \?/.test(sql)) return { bind: () => ({ run: async () => { throw new Error("D1 write failed"); } }) };
      return target.prepare(sql);
    };
    const v = (target as any)[prop];
    return typeof v === "function" ? v.bind(target) : v;
  } }) as D1Database;
  await processInstagramBatch(env({ DB: failing }));
  const job = (await getInstagramJob(db, p.id))!;
  assert.equal(job.status, "failed");
  assert.equal(job.ambiguous, true);
  assert.match(job.error!, /returned post id ig-media-1/);
  assert.equal(publishes().length, 1);
});
