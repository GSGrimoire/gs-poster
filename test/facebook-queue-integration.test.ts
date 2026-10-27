import { before, beforeEach, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { claimForPublish, createPost, ensureSchema, getPost } from "../src/db.ts";
import { enqueueFacebookUpload, ensureFacebookQueue, getFacebookUploadProgress, processFacebookUploadBatch } from "../src/facebook-queue.ts";
import type { Env } from "../src/env.ts";

let worker: Miniflare;
let db: D1Database;
let calls = 0;
let photos: string[] = [];
let feeds: URLSearchParams[] = [];
let holdPhoto: (() => Promise<void>) | undefined;
const realFetch = globalThis.fetch;
before(async () => {
  worker = new Miniflare(convertV4MiniflareOptions({ modules: true, cf: false,
    script: "export default { fetch() { return new Response('local queue tests'); } };",
    compatibilityDate: "2026-09-01", d1Databases: ["DB"] }));
  db = await worker.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
  await ensureFacebookQueue(db);
});
after(async () => { await worker?.dispose(); });
beforeEach(async () => {
  for (const name of ["facebook_upload_jobs", "bluesky_targets", "posts", "audit"]) await db.prepare(`DELETE FROM ${name}`).run();
  calls = 0; photos = []; feeds = []; holdPhoto = undefined;
  globalThis.fetch = async (input, init) => {
    calls++;
    const url = new URL(String(input));
    if (url.hostname === "raw.githubusercontent.com") return new Response("", { status: 404 });
    if (url.hostname === "api.github.com") return new Response(new Uint8Array([137, 80, 78, 71]));
    assert.equal(url.hostname, "graph.facebook.com", "no real or unexpected network request");
    if (url.pathname.endsWith("/photos")) {
      const body = init!.body as FormData;
      assert.equal(body.get("published"), "false");
      photos.push((body.get("source") as File).name);
      const id = `photo-${photos.length}`;
      const pause = holdPhoto;
      holdPhoto = undefined;
      if (pause) await pause();
      return Response.json({ id });
    }
    if (url.pathname.endsWith("/feed")) {
      feeds.push(new URLSearchParams(init!.body as URLSearchParams));
      return Response.json({ id: "123_456" });
    }
    return Response.json({ is_published: true, permalink_url: "https://www.facebook.com/123_456" });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function bulk(count = 80) {
  const p = await createPost(db, { message: "Archive", images: Array.from({ length: count }, (_, i) =>
    `https://raw.githubusercontent.com/example/images/main/${i}.png`), scheduled_at: null, created_by: "test" });
  assert.equal(await claimForPublish(db, p.id, { message: p.message, facebookEnabled: true,
    bluesky: null, scheduledAt: null, expectedUpdatedAt: p.updated_at }), true);
  const env = { DB: db, FB_PAGE_ID: "123", FB_PAGE_TOKEN: "test-only", GITHUB_READ_TOKEN: "test-only" } as Env;
  await enqueueFacebookUpload(env, p.id);
  return { env, id: p.id };
}

test("all 80 private images reach one feed in order, with at most 26 external calls per tick", async () => {
  const { env, id } = await bulk();
  for (let i = 0; i < 10; i++) {
    const previous = calls;
    await processFacebookUploadBatch(env);
    assert.ok(calls - previous <= 26);
    if (i < 9) assert.equal(feeds.length, 0);
  }
  assert.equal((await getPost(db, id))?.status, "published");
  assert.deepEqual(photos, Array.from({ length: 80 }, (_, i) => `${i}.png`));
  assert.equal(feeds.length, 1);
  assert.equal([...feeds[0].keys()].filter(key => key.startsWith("attached_media[")).length, 80);
  for (let i = 0; i < 80; i++) assert.deepEqual(JSON.parse(feeds[0].get(`attached_media[${i}]`)!), { media_fbid: `photo-${i + 1}` });
  await processFacebookUploadBatch(env);
  assert.equal(feeds.length, 1);
});

test("a delayed job selection cannot reclaim a newer completed batch using stale indexes", async () => {
  const { env, id } = await bulk();
  let selected!: () => void;
  let release!: () => void;
  const selection = new Promise<void>(resolve => { selected = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const delayedDb = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!sql.includes("SELECT f.*")) return statement;
      return { bind(...values: unknown[]) {
        const bound = statement.bind(...values);
        return { async first() { const row = await bound.first(); selected(); await gate; return row; } };
      } };
    },
  } as unknown as D1Database;
  const delayed = processFacebookUploadBatch({ ...env, DB: delayedDb });
  await selection;
  try { await processFacebookUploadBatch(env); } finally { release(); }
  await delayed;
  assert.equal(photos.length, 8, "stale selection must not upload image zero again");
  assert.equal((await getFacebookUploadProgress(db, id, 80))?.status, "uploading");
  assert.equal((await getFacebookUploadProgress(db, id, 80))?.uploaded, 8);
});

test("an expired worker cannot fail the batch now owned by a newer worker", async () => {
  const { env, id } = await bulk();
  let uploading!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { uploading = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  holdPhoto = async () => { uploading(); await gate; };
  const old = processFacebookUploadBatch(env);
  await started;
  await db.prepare("UPDATE facebook_upload_jobs SET started_at = ? WHERE post_id = ?")
    .bind(new Date(Date.now() - 3 * 60_000).toISOString(), id).run();
  let nextStarted!: () => void;
  let nextRelease!: () => void;
  const nextReady = new Promise<void>(resolve => { nextStarted = resolve; });
  const nextGate = new Promise<void>(resolve => { nextRelease = resolve; });
  holdPhoto = async () => { nextStarted(); await nextGate; };
  const next = processFacebookUploadBatch(env);
  await nextReady;
  release();
  await old;
  const during = await getFacebookUploadProgress(db, id, 80);
  nextRelease();
  await next;
  assert.equal(during?.uploaded, 0, "replaced worker must not save its late photo into the new lease");
  assert.equal(during?.status, "busy", "replaced worker must not fail the new active lease");
  const progress = await getFacebookUploadProgress(db, id, 80);
  assert.equal(progress?.uploaded, 8);
  assert.equal(progress?.status, "uploading");
  assert.equal(progress?.error, null);
  assert.equal(feeds.length, 0);
});
