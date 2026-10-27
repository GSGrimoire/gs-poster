import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  claimForPublish, createPost, ensureSchema, getPost,
} from "../src/db.ts";
import {
  abandonFacebookUpload, enqueueFacebookUpload,
  getFacebookUploadProgress, processFacebookUploadBatch, resumeFailedFacebookUploads,
} from "../src/facebook-queue.ts";
import { checkVideoUrl, fetchVideo } from "../src/video.ts";
import type { Env } from "../src/env.ts";

let worker: Miniflare;
let db: D1Database;
before(async () => {
  worker = new Miniflare(convertV4MiniflareOptions({
    modules: true, cf: false,
    script: "export default { fetch() { return new Response('queue tests'); } };",
    compatibilityDate: "2026-09-01", d1Databases: ["DB"],
  }));
  db = await worker.getD1Database("DB") as unknown as D1Database;
  // Reproduce a prior production database with no video column.
  await db.prepare(`CREATE TABLE bluesky_targets (
    post_id TEXT PRIMARY KEY, caption TEXT NOT NULL, images TEXT NOT NULL DEFAULT '[]',
    patreon TEXT, facebook_enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft', uri TEXT, cid TEXT, card_uri TEXT,
    permalink TEXT, error TEXT, started_at TEXT)`).run();
  await ensureSchema(db);
});
after(async () => { await worker?.dispose(); });

async function approvedBulk(n: number, scheduled: Date | null) {
  const p = await createPost(db, {
    message: "A test Facebook post", images: Array(n).fill("https://raw.githubusercontent.com/example/repo/main/test.png"),
    scheduled_at: scheduled?.toISOString() ?? null, created_by: "test",
  });
  const claimed = await claimForPublish(db, p.id, {
    message: p.message, facebookEnabled: true, bluesky: null,
    scheduledAt: scheduled, expectedUpdatedAt: p.updated_at,
  });
  assert.equal(claimed, true);
  const env = { DB: db } as Env;
  await enqueueFacebookUpload(env, p.id);
  return {env,id:p.id};
}

test("old deployed D1 schema is migrated without losing existing columns", async () => {
  const cols = await db.prepare("PRAGMA table_info(bluesky_targets)").all<{name:string}>();
  assert.ok(cols.results.some(x => x.name === "video"));
  assert.ok(cols.results.some(x => x.name === "patreon"));
});

test("failed Facebook photo batch resumes only unsubmitted uploads", async () => {
  const {env,id} = await approvedBulk(11,null);
  await db.prepare(`UPDATE facebook_upload_jobs
    SET status = 'failed', next_index = 4, error = 'temporary photo error' WHERE post_id = ?`).bind(id).run();
  assert.equal(await resumeFailedFacebookUploads(env,id,"reviewer"),true);
  const progress = await getFacebookUploadProgress(db,id,11);
  assert.equal(progress?.status,"uploading");
  assert.equal(progress?.uploaded,4);
  assert.equal(await resumeFailedFacebookUploads(env,id,"reviewer"),false);
});

test("ambiguous Facebook final send is never retried by resume; manual abandon is terminal", async () => {
  const {env,id} = await approvedBulk(11,null);
  await db.prepare(`UPDATE facebook_upload_jobs
    SET status = 'failed', next_index = 11, error = 'final send uncertain' WHERE post_id = ?`).bind(id).run();
  assert.equal(await resumeFailedFacebookUploads(env,id,"reviewer"),false);
  assert.equal(await abandonFacebookUpload(env,id,"reviewer"),true);
  assert.equal((await getFacebookUploadProgress(db,id,11))?.status,"cancelled");
  assert.equal((await getPost(db,id))?.status,"failed");
  assert.equal(await abandonFacebookUpload(env,id,"reviewer"),false);
});

test("expired scheduled lead fails before any Facebook final Graph request", async () => {
  const soon = new Date(Date.now() + 5*60_000);
  const {env,id} = await approvedBulk(11,soon);
  await db.prepare(`UPDATE facebook_upload_jobs
    SET next_index = 11, media_ids = ?, status = 'uploading'
    WHERE post_id = ?`).bind(JSON.stringify(Array(11).fill("test-media-id")),id).run();
  // No Facebook credentials: if a Graph call is attempted, it would fail differently.
  await processFacebookUploadBatch(env);
  const state = await getFacebookUploadProgress(db,id,11);
  assert.equal(state?.status,"failed");
  assert.match(state?.error ?? "",/Scheduled time became too close/);
  assert.equal((await getPost(db,id))?.status,"publishing");
});

test("private MP4 references are validated and read without public HTTP requests", async () => {
  const ref = "upload://"+"a".repeat(32)+".mp4";
  assert.equal(checkVideoUrl(ref),null);
  assert.match(checkVideoUrl("upload://"+"a".repeat(32)+".png")??"",/MP4/);
  const bytes = new Uint8Array([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0]);
  const env = { UPLOADS: {
    get: async () => ({arrayBuffer: async () => bytes.buffer}),
  }} as unknown as Env;
  assert.deepEqual(await fetchVideo(env,ref),bytes);
});
