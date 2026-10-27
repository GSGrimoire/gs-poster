import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { claimForPublish, claimFailedBluesky, createPost, getPost, setBlueskyStatus, updatePost, type ApprovalSnapshot } from "../src/db.ts";
import { backToDraft } from "../src/publish.ts";
import type { Env } from "../src/env.ts";

let worker: Miniflare;
let db: D1Database;
before(async () => {
  worker = new Miniflare(convertV4MiniflareOptions({ modules: true, cf: false,
    script: "export default { fetch() { return new Response('local database test'); } };",
    compatibilityDate: "2026-09-01", d1Databases: ["DB"] }));
  db = await worker.getD1Database("DB") as unknown as D1Database;
});
after(async () => { await worker?.dispose(); });

async function draft() {
  return createPost(db, { message: "Original", images: [], scheduled_at: null, created_by: "test",
    bluesky: { caption: "Original Bluesky", images: [], patreon: null } });
}

test("concurrent approvals retain exactly the winning caption, schedule and target selection", async () => {
  for (let i = 0; i < 20; i++) {
    const p = await draft();
    const options: ApprovalSnapshot[] = [
      { message: "Facebook approval", facebookEnabled: true, bluesky: null,
        scheduledAt: null, expectedUpdatedAt: p.updated_at },
      { message: "Bluesky approval", facebookEnabled: false,
        bluesky: { caption: "Approved Bluesky", images: [], patreon: null },
        scheduledAt: new Date("2030-01-01T12:00:00Z"), expectedUpdatedAt: p.updated_at },
    ];
    if (i % 2) options.reverse();
    const claimed = await Promise.all(options.map(option => claimForPublish(db, p.id, option)));
    assert.equal(claimed.filter(Boolean).length, 1);
    const winner = options[claimed.indexOf(true)];
    const saved = (await getPost(db, p.id))!;
    assert.equal(saved.status, "publishing");
    assert.ok(saved.approved_at);
    assert.equal(saved.message, winner.message);
    assert.equal(saved.scheduled_at, winner.scheduledAt?.toISOString() ?? null);
    assert.equal(saved.facebook_enabled, winner.facebookEnabled);
    assert.equal(saved.bluesky?.caption ?? null, winner.bluesky?.caption ?? null);
    const loser = options[claimed.indexOf(false)];
    assert.equal(await claimForPublish(db, p.id, loser), false);
    assert.deepEqual(await getPost(db, p.id), saved, "a late losing request must change nothing");
  }
});

test("stale draft versions cannot change targets or claim a newer draft", async () => {
  const p = await draft();
  await db.prepare("UPDATE posts SET updated_at = ?, message = ? WHERE id = ?")
    .bind("2030-01-01T00:00:00Z", "Newer draft", p.id).run();
  const input = { message: "Stale approval", facebookEnabled: true, bluesky: null,
    scheduledAt: null, expectedUpdatedAt: p.updated_at };
  assert.equal(await claimForPublish(db, p.id, input), false);
  const saved = (await getPost(db, p.id))!;
  assert.equal(saved.status, "draft");
  assert.equal(saved.message, "Newer draft");
  assert.equal(saved.bluesky?.caption, "Original Bluesky");
  await updatePost(db, p.id, { status: "rejected" });
  assert.equal(await claimForPublish(db, p.id, { ...input, expectedUpdatedAt: (await getPost(db, p.id))!.updated_at }), false);
});

test("failed approval transaction rolls target changes back", async () => {
  const p = await draft();
  await db.prepare(`CREATE TRIGGER fail_test_approval BEFORE UPDATE OF status ON posts
    WHEN NEW.status = 'publishing' BEGIN SELECT RAISE(ABORT, 'test rollback'); END`).run();
  try {
    await assert.rejects(claimForPublish(db, p.id, { message: "Never committed", facebookEnabled: true,
      bluesky: null, scheduledAt: null, expectedUpdatedAt: p.updated_at }), /test rollback/);
    assert.deepEqual(await getPost(db, p.id), p);
  } finally {
    await db.prepare("DROP TRIGGER fail_test_approval").run();
  }
});

test("failed target recovery requires reconciliation and Bluesky retries are atomic and timed", async () => {
  const p = await draft();
  const claimed = await claimForPublish(db, p.id, {
    message: "Approved", facebookEnabled: true,
    bluesky: { caption: "Approved Bluesky", images: [], patreon: null },
    scheduledAt: null, expectedUpdatedAt: p.updated_at,
  });
  assert.equal(claimed, true);
  await updatePost(db, p.id, { status: "failed", error: "facebook ambiguous" }, ["publishing"]);
  await setBlueskyStatus(db, p.id, { status: "failed", error: "bluesky error" }, ["draft"]);
  const env = { DB: db } as Env;
  assert.equal(await backToDraft(env, p.id, "test"), false, "approved retries need human reconciliation");
  const attempts = await Promise.all([
    claimFailedBluesky(db, p.id), claimFailedBluesky(db, p.id),
  ]);
  assert.equal(attempts.filter(Boolean).length, 1);
  const first = await db.prepare("SELECT status, started_at FROM bluesky_targets WHERE post_id = ?")
    .bind(p.id).first<{ status: string; started_at: string | null }>();
  assert.equal(first?.status, "publishing");
  assert.ok(first?.started_at, "retry must timestamp the atomic publishing claim");
  assert.equal(await backToDraft(env, p.id, "test", true), false, "active Bluesky claim blocks redraft");
  await setBlueskyStatus(db, p.id, { status: "failed", error: "again" }, ["publishing"]);
  assert.equal(await backToDraft(env, p.id, "test", true), true);
  assert.equal((await getPost(db, p.id))?.status, "draft");
});

test("a published Bluesky target cannot be inadvertently re-drafted", async () => {
  const p = await draft();
  await claimForPublish(db, p.id, {
    message: "Approved", facebookEnabled: true,
    bluesky: { caption: "Already sent", images: [], patreon: null },
    scheduledAt: null, expectedUpdatedAt: p.updated_at,
  });
  await updatePost(db, p.id, { status: "failed" }, ["publishing"]);
  await setBlueskyStatus(db, p.id, { status: "published", uri: "at://test" }, ["draft"]);
  assert.equal(await backToDraft({DB:db} as Env, p.id, "test", true), false);
});
