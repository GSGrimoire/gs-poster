// PR #52 review blocker: a post whose Facebook queue was abandoned (or whose
// cancelled schedule was verified absent) must go back to drafts and be
// approvable again. The old job row is reset only on a fresh PIN-approved
// claim, and only when it is `cancelled` or `done`. Active or ambiguous rows
// (`uploading`, `busy`, `sending`, `failed`) are never reactivated.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  claimForPublish, createPost, ensureSchema, getPost, reopenCancelledDraft, setBlueskyStatus, updatePost,
} from "../src/db.ts";
import {
  abandonFacebookUpload, enqueueFacebookUpload, ensureFacebookQueue, getFacebookUploadProgress,
} from "../src/facebook-queue.ts";
import { approveAndPublish, backToDraft } from "../src/publish.ts";
import type { Env } from "../src/env.ts";

let worker: Miniflare;
let db: D1Database;
let env: Env;
before(async () => {
  worker = new Miniflare(convertV4MiniflareOptions({
    modules: true, cf: false,
    script: "export default { fetch() { return new Response('requeue tests'); } };",
    compatibilityDate: "2026-09-01", d1Databases: ["DB"],
  }));
  db = await worker.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
  await ensureFacebookQueue(db);
  env = { DB: db } as Env;
});
after(async () => { await worker?.dispose(); });

const IMG = "https://raw.githubusercontent.com/example/repo/main/slide.png";
const MSG = "Five ways to open a campaign. Free in the Archive: patreon.com/GSGrimoire";

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

async function approveDraft(id: string, scheduled: Date | null = null) {
  const p = (await getPost(db, id))!;
  return withNoNetwork(() => approveAndPublish(env, id, {
    message: p.message, facebookEnabled: true, bluesky: null,
    scheduledAt: scheduled, expectedUpdatedAt: p.updated_at, actor: "gus",
  }));
}

async function job(id: string) {
  return db.prepare("SELECT * FROM facebook_upload_jobs WHERE post_id = ?").bind(id)
    .first<{ status: string; next_index: number; media_ids: string; started_at: string | null; error: string | null }>();
}

/** Approve, then fake a queue that uploaded part of the gallery and failed. */
async function abandonedPost(images: number, jobStatus: "failed" | "sending" = "failed") {
  const p = await createPost(db, { message: MSG, images: Array(images).fill(IMG), scheduled_at: null, scheduled_at: null, created_by: "test" });
  const { result } = await approveDraft(p.id);
  assert.equal(result.status, "publishing");
  const uploaded = Math.min(3, images);
  await db.prepare(`UPDATE facebook_upload_jobs SET status = ?, next_index = ?, media_ids = ?,
      started_at = ?, error = 'boom' WHERE post_id = ?`)
    .bind(jobStatus, uploaded, JSON.stringify(Array.from({ length: uploaded }, (_, i) => "m" + i)),
      new Date().toISOString(), p.id).run();
  assert.equal(await abandonFacebookUpload(env, p.id, "gus"), true);
  assert.equal((await getPost(db, p.id))?.status, "failed");
  assert.equal((await job(p.id))?.status, "cancelled");
  return p.id;
}

for (const n of [1, 7, 11]) {
  test(`abandoned ${n}-photo post: back to drafts, edit, re-approve queues from zero`, async () => {
    const id = await abandonedPost(n);
    assert.match((await getPost(db, id))?.error ?? "", /move it back to drafts/);
    assert.equal(await backToDraft(env, id, "gus", true), true);
    const d = (await getPost(db, id))!;
    assert.equal(d.status, "draft");
    // Editing the draft before posting again works as for any draft.
    assert.equal(await updatePost(db, id, { message: MSG + " Edited." }, ["draft"]), true);
    const { result, calls } = await approveDraft(id);
    assert.deepEqual(calls, [], "re-approval must not contact Facebook");
    assert.equal(result.status, "publishing");
    assert.equal(result.error, null);
    const j = (await job(id))!;
    assert.equal(j.status, "uploading");
    assert.equal(j.next_index, 0);
    assert.equal(j.media_ids, "[]");
    assert.equal(j.started_at, null);
    assert.equal(j.error, null);
    assert.equal((await getFacebookUploadProgress(db, id, n))?.uploaded, 0);
  });
}

test("abandon after an ambiguous send also allows a fresh approval later", async () => {
  const id = await abandonedPost(7, "sending");
  assert.equal(await backToDraft(env, id, "gus", true), true);
  const { result } = await approveDraft(id);
  assert.equal(result.status, "publishing");
  assert.equal((await job(id))?.status, "uploading");
});

test("a duplicate re-approval cannot enqueue twice", async () => {
  const id = await abandonedPost(4);
  assert.equal(await backToDraft(env, id, "gus", true), true);
  const before = (await getPost(db, id))!;
  await approveDraft(id);
  // The same stale form submitted again loses the draft claim.
  await assert.rejects(withNoNetwork(() => approveAndPublish(env, id, {
    message: before.message, facebookEnabled: true, bluesky: null,
    scheduledAt: null, expectedUpdatedAt: before.updated_at, actor: "gus",
  })), /no longer a draft/);
  assert.equal((await job(id))?.status, "uploading");
});

test("a scheduled re-approval keeps the new schedule", async () => {
  const id = await abandonedPost(7);
  assert.equal(await backToDraft(env, id, "gus", true), true);
  const when = new Date(Date.now() + 2 * 60 * 60_000);
  const { result } = await approveDraft(id, when);
  assert.equal(result.status, "publishing");
  assert.equal((await getPost(db, id))?.scheduled_at, when.toISOString());
  assert.equal((await job(id))?.status, "uploading");
});

for (const status of ["uploading", "busy", "sending", "failed"]) {
  test(`an existing '${status}' job is never reset by enqueue`, async () => {
    const p = await createPost(db, { message: MSG, images: [IMG, IMG], scheduled_at: null, scheduled_at: null, created_by: "test" });
    assert.equal(await claimForPublish(db, p.id, {
      message: p.message, facebookEnabled: true, bluesky: null, scheduledAt: null, expectedUpdatedAt: p.updated_at,
    }), true);
    const started = new Date().toISOString();
    await db.prepare(`INSERT INTO facebook_upload_jobs (post_id, media_ids, next_index, status, started_at, error)
      VALUES (?, '["a"]', 1, ?, ?, 'kept')`).bind(p.id, status, started).run();
    await assert.rejects(enqueueFacebookUpload(env, p.id), /Could not enqueue/);
    const j = (await job(p.id))!;
    assert.equal(j.status, status);
    assert.equal(j.next_index, 1);
    assert.equal(j.media_ids, '["a"]');
    assert.equal(j.started_at, started);
  });
}

test("a done job is not reset while the post still records a Facebook id", async () => {
  const p = await createPost(db, { message: MSG, images: [IMG], scheduled_at: null, scheduled_at: null, created_by: "test" });
  assert.equal(await claimForPublish(db, p.id, {
    message: p.message, facebookEnabled: true, bluesky: null, scheduledAt: null, expectedUpdatedAt: p.updated_at,
  }), true);
  await db.prepare("UPDATE posts SET fb_post_id = '476872498846005_9' WHERE id = ?").bind(p.id).run();
  await db.prepare(`INSERT INTO facebook_upload_jobs (post_id, media_ids, next_index, status)
    VALUES (?, '["a"]', 1, 'done')`).bind(p.id).run();
  await assert.rejects(enqueueFacebookUpload(env, p.id), /Could not enqueue/);
  assert.equal((await job(p.id))?.status, "done");
});

test("a cancelled scheduled post reopened as a draft can be approved again", async () => {
  const p = await createPost(db, { message: MSG, images: [IMG, IMG, IMG], scheduled_at: null, scheduled_at: null, created_by: "test" });
  await approveDraft(p.id, new Date(Date.now() + 2 * 60 * 60_000));
  // Cron finished the queue and Facebook scheduled it; later it was cancelled.
  await db.prepare("UPDATE facebook_upload_jobs SET status = 'done', next_index = 3, media_ids = '[\"a\",\"b\",\"c\"]' WHERE post_id = ?")
    .bind(p.id).run();
  await updatePost(db, p.id, { status: "scheduled", fb_post_id: "476872498846005_7" }, ["publishing"]);
  await updatePost(db, p.id, { status: "cancelled" }, ["scheduled"]);
  const cancelled = (await getPost(db, p.id))!;
  // restoreCancelledPost verifies absence on Facebook first; this is its D1 step.
  assert.equal(await reopenCancelledDraft(db, p.id, cancelled.updated_at), true);
  const { result, calls } = await approveDraft(p.id);
  assert.deepEqual(calls, []);
  assert.equal(result.status, "publishing");
  const j = (await job(p.id))!;
  assert.equal(j.status, "uploading");
  assert.equal(j.next_index, 0);
  assert.equal(j.media_ids, "[]");
});

test("combined targets: an active Bluesky target blocks the redraft", async () => {
  const p = await createPost(db, { message: MSG, images: [IMG, IMG], scheduled_at: null, created_by: "test",
    bluesky: { caption: "Bluesky caption", images: [], patreon: null } });
  const when = new Date(Date.now() + 2 * 60 * 60_000);
  await withNoNetwork(() => approveAndPublish(env, p.id, {
    message: p.message, facebookEnabled: true,
    bluesky: { caption: "Bluesky caption", images: [], patreon: null },
    scheduledAt: when, expectedUpdatedAt: p.updated_at, actor: "gus",
  }));
  assert.equal((await getPost(db, p.id))?.bluesky?.status, "scheduled");
  await db.prepare("UPDATE facebook_upload_jobs SET status = 'failed' WHERE post_id = ?").bind(p.id).run();
  assert.equal(await abandonFacebookUpload(env, p.id, "gus"), true);
  assert.equal(await backToDraft(env, p.id, "gus", true), false);
  assert.equal((await getPost(db, p.id))?.status, "failed");
  // Once Bluesky is no longer active, the post can come back as a draft.
  assert.equal(await setBlueskyStatus(db, p.id, { status: "failed", error: "stopped" }, ["scheduled"]), true);
  assert.equal(await backToDraft(env, p.id, "gus", true), true);
  const d = (await getPost(db, p.id))!;
  assert.equal(d.status, "draft");
  assert.equal(d.bluesky?.status, "draft");
});
