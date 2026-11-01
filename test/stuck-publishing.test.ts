// Issue #49: photo posts must never upload inside the approval request, and a
// stranded `publishing` record must be recoverable by a PIN-gated human action
// that sends nothing.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { claimForPublish, createPost, ensureSchema, getPost, updatePost } from "../src/db.ts";
import { BULK_FACEBOOK_THRESHOLD, enqueueFacebookUpload, getFacebookUploadProgress } from "../src/facebook-queue.ts";
import {
  approveAndPublish, backToDraft, isStuckPublishing, reconcileStuckPublishing, STUCK_PUBLISHING_MS,
} from "../src/publish.ts";
import type { Env } from "../src/env.ts";

let worker: Miniflare;
let db: D1Database;
let env: Env;
before(async () => {
  worker = new Miniflare(convertV4MiniflareOptions({
    modules: true, cf: false,
    script: "export default { fetch() { return new Response('stuck tests'); } };",
    compatibilityDate: "2026-09-01", d1Databases: ["DB"],
  }));
  db = await worker.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
  env = { DB: db } as Env;
});
after(async () => { await worker?.dispose(); });

const IMG = "https://raw.githubusercontent.com/example/repo/main/slide.png";

/** Any outbound request during approval is a failure of this fix. */
async function withNoNetwork<T>(fn: () => Promise<T>): Promise<{ result: T; calls: string[] }> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input instanceof Request ? input.url : input));
    throw new Error("network disabled in this test");
  }) as typeof fetch;
  try { return { result: await fn(), calls }; }
  finally { globalThis.fetch = original; }
}

async function draft(images: number, scheduled: Date | null = null) {
  return createPost(db, {
    message: "Five ways to open a campaign. Free in the Archive: patreon.com/GSGrimoire",
    images: Array(images).fill(IMG), scheduled_at: scheduled?.toISOString() ?? null, created_by: "test",
  });
}

async function approve(images: number, scheduled: Date | null = null) {
  const p = await draft(images, scheduled);
  const { result, calls } = await withNoNetwork(() => approveAndPublish(env, p.id, {
    message: p.message, facebookEnabled: true, bluesky: null,
    scheduledAt: scheduled, expectedUpdatedAt: p.updated_at, actor: "gus",
  }));
  return { post: result, calls };
}

/** Recreate the production state: claimed, no Facebook id, no queue job. */
async function strandedPost(ageMs: number) {
  const p = await draft(7);
  assert.equal(await claimForPublish(db, p.id, {
    message: p.message, facebookEnabled: true, bluesky: null, scheduledAt: null, expectedUpdatedAt: p.updated_at,
  }), true);
  const old = new Date(Date.now() - ageMs).toISOString();
  await db.prepare("UPDATE posts SET updated_at = ? WHERE id = ?").bind(old, p.id).run();
  return (await getPost(db, p.id))!;
}

test("every photo post is queued, so the threshold is zero", () => {
  assert.equal(BULK_FACEBOOK_THRESHOLD, 0);
});

for (const n of [1, 7, 11]) {
  test(`approving a ${n}-photo post makes no Facebook or image request and creates a queue job`, async () => {
    const { post, calls } = await approve(n);
    assert.deepEqual(calls, []);
    assert.equal(post.status, "publishing");
    assert.equal(post.fb_post_id, null);
    const job = await getFacebookUploadProgress(db, post.id, n);
    assert.equal(job?.status, "uploading");
    assert.equal(job?.uploaded, 0);
  });
}

test("a scheduled photo post is queued as well", async () => {
  const { post, calls } = await approve(7, new Date(Date.now() + 60 * 60_000));
  assert.deepEqual(calls, []);
  assert.equal((await getFacebookUploadProgress(db, post.id, 7))?.status, "uploading");
});

test("a text-only post still records a result instead of stranding", async () => {
  const { post } = await approve(0);
  // The direct Graph request fails here; the record must say so, not stay publishing.
  assert.equal(post.status, "failed");
  assert.ok(post.error);
  assert.equal(await getFacebookUploadProgress(db, post.id, 0), null);
});

test("a stranded post is recoverable only after the waiting period", async () => {
  const fresh = await strandedPost(STUCK_PUBLISHING_MS - 60_000);
  assert.equal(await isStuckPublishing(db, fresh), false);
  assert.equal(await reconcileStuckPublishing(env, fresh.id, fresh.updated_at, "gus"), false);
  assert.equal((await getPost(db, fresh.id))?.status, "publishing");
});

test("reconciliation needs the current version, moves to failed, and is one-shot", async () => {
  const p = await strandedPost(STUCK_PUBLISHING_MS + 60_000);
  assert.equal(await isStuckPublishing(db, p), true);
  assert.equal(await reconcileStuckPublishing(env, p.id, "stale-version", "gus"), false);
  assert.equal(await reconcileStuckPublishing(env, p.id, p.updated_at, "gus"), true);
  const after = (await getPost(db, p.id))!;
  assert.equal(after.status, "failed");
  assert.equal(after.fb_post_id, null);
  assert.match(after.error ?? "", /Nothing was resent/);
  assert.equal(await reconcileStuckPublishing(env, p.id, after.updated_at, "gus"), false);
  const audit = await db.prepare("SELECT action FROM audit WHERE post_id = ? AND action = 'stuck-publishing-reconciled'")
    .bind(p.id).all();
  assert.equal(audit.results.length, 1);
  // The existing PIN-gated redraft path then reopens it for a fresh approval.
  assert.equal(await backToDraft(env, p.id, "gus", true), true);
  assert.equal((await getPost(db, p.id))?.status, "draft");
});

test("a post with a queue job is left to the queue's own recovery", async () => {
  const p = await strandedPost(STUCK_PUBLISHING_MS + 60_000);
  await enqueueFacebookUpload(env, p.id);
  const current = (await getPost(db, p.id))!;
  assert.equal(await isStuckPublishing(db, current), false);
  assert.equal(await reconcileStuckPublishing(env, p.id, current.updated_at, "gus"), false);
});

test("a post with a recorded Facebook id is never marked failed", async () => {
  const p = await strandedPost(STUCK_PUBLISHING_MS + 60_000);
  await db.prepare("UPDATE posts SET fb_post_id = ? WHERE id = ?").bind("476872498846005_1", p.id).run();
  const current = (await getPost(db, p.id))!;
  assert.equal(await isStuckPublishing(db, current), false);
  assert.equal(await reconcileStuckPublishing(env, p.id, current.updated_at, "gus"), false);
});

test("drafts and published posts are never eligible", async () => {
  const d = await draft(3);
  assert.equal(await isStuckPublishing(db, d), false);
  const p = await strandedPost(STUCK_PUBLISHING_MS + 60_000);
  await updatePost(db, p.id, { status: "published", fb_post_id: "476872498846005_2" }, ["publishing"]);
  assert.equal(await isStuckPublishing(db, (await getPost(db, p.id))!), false);
});
