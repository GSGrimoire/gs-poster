import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { claimForPublish, createPost, getPost, updatePost, type ApprovalSnapshot } from "../src/db.ts";

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
