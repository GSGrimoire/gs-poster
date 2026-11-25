import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { processScheduledWork } from "../src/cron.ts";
import { createPost, ensureSchema } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import { ensureFacebookQueue } from "../src/facebook-queue.ts";
import { ensureInstagramJobs } from "../src/instagram-publish.ts";

const IG_ID = "178414000000001";
const originalFetch = globalThis.fetch;
const approveTime = () => new Date(Date.now() - 60 * 60_000).toISOString();
const future = () => new Date(Date.now() + 60 * 60_000).toISOString();
let worker: Miniflare;
let db: D1Database;
let outbound: string[];

before(async () => {
  worker = new Miniflare(convertV4MiniflareOptions({ modules: true, cf: false,
    script: "export default { fetch() { return new Response('local cron tests'); } };",
    compatibilityDate: "2026-09-01", d1Databases: ["DB"] }));
  db = await worker.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
  await ensureFacebookQueue(db);
  await ensureInstagramJobs(db);
});
after(async () => { await worker?.dispose(); });
beforeEach(async () => {
  for (const table of ["facebook_upload_jobs", "instagram_media_grants", "instagram_jobs", "bluesky_targets", "posts", "audit"]) {
    await db.prepare("DELETE FROM " + table).run();
  }
  outbound = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    outbound.push(url.pathname);
    assert.equal(url.hostname, "graph.facebook.com");
    if (init?.method === "POST" && url.pathname.endsWith("/" + IG_ID + "/media")) {
      return Response.json({ id: "fixture-container" });
    }
    if (url.pathname.endsWith("/fixture-container")) return Response.json({ status_code: "IN_PROGRESS" });
    assert.fail("Unexpected provider operation in cron eligibility test: " + url.pathname);
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  assert.ok(outbound.every(path => path.endsWith("/media") || path.endsWith("/fixture-container")));
});

function observe(fault?: "probe" | "facebook") {
  const sql: string[] = [];
  const tracked = {
    prepare(statement: string) {
      sql.push(statement);
      if ((fault === "probe" && statement.includes("AS has_work")) ||
          (fault === "facebook" && statement.startsWith("SELECT f.*"))) {
        throw new Error("Simulated database error");
      }
      return db.prepare(statement);
    },
    batch(statements: D1PreparedStatement[]) {
      sql.push("batch");
      return db.batch(statements);
    },
  } as D1Database;
  const env = { DB: tracked, FB_PAGE_ID: "123", FB_PAGE_TOKEN: "local-only", GRAPH_VERSION: "v24.0", IG_USER_ID: IG_ID,
    PUBLIC_ORIGIN: "https://poster.test" } as Env;
  return { env, sql };
}

async function facebook(status: string, startedAt: string | null, approved = true) {
  // Facebook's claim still notices this queued row. The platform's existing
  // preflight stops here because the fixture is disabled for Facebook.
  const post = await createPost(db, { message: "Local fixture", images: [], facebook_enabled: false,
    scheduled_at: null, created_by: "test" });
  await db.prepare("UPDATE posts SET status = 'publishing', approved_at = ? WHERE id = ?")
    .bind(approved ? approveTime() : null, post.id).run();
  await db.prepare("INSERT INTO facebook_upload_jobs (post_id, status, started_at) VALUES (?, ?, ?)")
    .bind(post.id, status, startedAt).run();
  return () => db.prepare("SELECT status, started_at FROM facebook_upload_jobs WHERE post_id = ?")
    .bind(post.id).first<{ status: string; started_at: string | null }>();
}

async function bluesky(status: string, startedAt: string | null, dueAt = approveTime(), approved = true) {
  const post = await createPost(db, { message: "Local fixture", images: [], facebook_enabled: false,
    scheduled_at: dueAt, created_by: "test", bluesky: { caption: "Local fixture", images: [], patreon: null } });
  await db.prepare("UPDATE posts SET status = 'scheduled', approved_at = ? WHERE id = ?")
    .bind(approved ? approveTime() : null, post.id).run();
  await db.prepare("UPDATE bluesky_targets SET status = ?, started_at = ? WHERE post_id = ?")
    .bind(status, startedAt, post.id).run();
  return () => db.prepare("SELECT status FROM bluesky_targets WHERE post_id = ?").bind(post.id).first<string>("status");
}

async function instagram(status: string, lease: string | null, dueAt = approveTime(), orphan = false) {
  const id = orphan ? "deleted_fixture" : (await createPost(db, { message: "Local fixture", images: [],
    scheduled_at: dueAt, created_by: "test" })).id;
  await db.prepare(`INSERT INTO instagram_jobs (post_id, status, kind, due_at, caption, frame, items,
    container_id, processing_since, lease_until, created_by, updated_at)
    VALUES (?, ?, 'IMAGE', ?, 'Local fixture', '1:1', '[]', 'fixture-container', ?, ?, 'test', ?)`)
    .bind(id, status, dueAt, approveTime(), lease, approveTime()).run();
  return () => db.prepare("SELECT status, ambiguous, lease_until FROM instagram_jobs WHERE post_id = ?")
    .bind(id).first<{ status: string; ambiguous: number; lease_until: string | null }>();
}

test("one read-only probe skips an idle tick, even with future, protected and manual-retry rows", async () => {
  await facebook("busy", new Date().toISOString());
  await facebook("sending", approveTime());
  await facebook("uploading", null, false);
  await bluesky("scheduled", null, future());
  await bluesky("publishing", new Date().toISOString());
  await bluesky("scheduled", null, approveTime(), false);
  await bluesky("failed", approveTime());
  await instagram("scheduled", null, future());
  await instagram("sending", future());
  await instagram("failed", null);
  const { env, sql } = observe();
  await processScheduledWork(env);
  assert.equal(sql.length, 1);
  assert.match(sql[0], /^SELECT .*has_work/s);
  assert.deepEqual(outbound, []);
});

for (const status of ["uploading", "busy"]) {
  test(`cron claims Facebook ${status === "busy" ? "with an expired lease" : "uploading work"}`, async () => {
    const stale = status === "busy" ? approveTime() : null;
    const read = await facebook(status, stale);
    const { env } = observe();
    await processScheduledWork(env);
    const saved = await read();
    assert.equal(saved?.status, "busy");
    assert.notEqual(saved?.started_at, stale);
    assert.deepEqual(outbound, []);
  });
}

for (const status of ["scheduled", "publishing"]) {
  test(`cron reaches Bluesky ${status === "publishing" ? "after a stale claim" : "when due"}`, async () => {
    const read = await bluesky(status, status === "publishing" ? approveTime() : null);
    const { env } = observe();
    await processScheduledWork(env);
    assert.equal(await read(), "failed", "the local fixture has no Bluesky credentials");
    assert.deepEqual(outbound, []);
  });
}

test("cron advances due Instagram work to processing without sending a post", async () => {
  const read = await instagram("scheduled", null);
  const { env } = observe();
  await processScheduledWork(env);
  assert.equal((await read())?.status, "processing");
  assert.equal(outbound.length, 1);
});

test("cron reclaims an expired Instagram processing lease even when due_at is ahead", async () => {
  const read = await instagram("processing", approveTime(), future());
  const { env } = observe();
  await processScheduledWork(env);
  assert.deepEqual(await read(), { status: "processing", ambiguous: 0, lease_until: null });
  assert.equal(outbound.length, 1);
});

test("an expired final Instagram send is recorded as unclear without retrying it", async () => {
  const read = await instagram("sending", approveTime());
  const { env } = observe();
  await processScheduledWork(env);
  assert.deepEqual(await read(), { status: "failed", ambiguous: 1, lease_until: null });
  assert.deepEqual(outbound, []);
});

test("a deleted post with future Instagram work still triggers orphan cleanup", async () => {
  const read = await instagram("scheduled", null, future(), true);
  const { env } = observe();
  await processScheduledWork(env);
  assert.equal((await read())?.status, "cancelled");
  assert.deepEqual(outbound, []);
});

test("the probe ignores Instagram when the platform is unconfigured", async () => {
  const read = await instagram("sending", approveTime());
  const { env, sql } = observe();
  await processScheduledWork({ ...env, IG_USER_ID: undefined });
  assert.equal((await read())?.status, "sending");
  assert.equal(sql.length, 1);
});

test("a probe failure still runs eligible platform work", async () => {
  const read = await bluesky("scheduled", null);
  const { env } = observe("probe");
  await processScheduledWork(env);
  assert.equal(await read(), "failed");
});

test("one failed batch still lets the other two platforms run", async () => {
  await facebook("uploading", null);
  const readBluesky = await bluesky("scheduled", null);
  const readInstagram = await instagram("sending", approveTime());
  const { env } = observe("facebook");
  await assert.rejects(processScheduledWork(env), /One or more scheduled publication batches failed/);
  assert.equal(await readBluesky(), "failed");
  assert.equal((await readInstagram())?.ambiguous, 1);
  assert.deepEqual(outbound, []);
});
