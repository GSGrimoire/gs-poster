import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createUpload, getUploadUsage, UPLOAD_QUOTA_BYTES } from "../src/upload.ts";
import type { Env } from "../src/env.ts";

const MiB = 1024 * 1024;
let worker: Miniflare;
let db: D1Database;
let env: Env;
before(async () => {
  worker = new Miniflare(convertV4MiniflareOptions({
    modules: true, cf: false,
    script: "export default { fetch() { return new Response('test'); } };",
    compatibilityDate: "2026-09-01", d1Databases: ["DB"],
  }));
  db = await worker.getD1Database("DB") as unknown as D1Database;
  env = { DB: db, UPLOADS: {} as R2Bucket } as Env;
  await getUploadUsage(db); // creates the actual schema via ensureUploads
});
after(async () => { await worker?.dispose(); });

async function stored(bytes: number) {
  const now = new Date();
  await db.prepare("INSERT INTO uploads (id, token_hash, ext, max_bytes, status, created_at, expires_at, bytes, created_by) VALUES (?, ?, 'png', ?, 'stored', ?, ?, ?, 'test')")
    .bind(crypto.randomUUID(), "not-a-real-token", bytes,
      new Date(now.getTime() - 25 * 3600_000).toISOString(),
      new Date(now.getTime() - 24 * 3600_000).toISOString(), bytes).run();
}

test("storage is reserved atomically for simultaneous OAuth upload links", async () => {
  // One 10 MiB grant fits; a second would exceed the 3 GiB application budget.
  await stored(UPLOAD_QUOTA_BYTES - 15 * MiB);
  const attempts = await Promise.allSettled([
    createUpload(env,"https://poster.test",{filename:"a.png",actor:"test"}),
    createUpload(env,"https://poster.test",{filename:"b.png",actor:"test"}),
  ]);
  assert.equal(attempts.filter(x => x.status === "fulfilled").length,1);
  assert.equal(attempts.filter(x => x.status === "rejected").length,1);
  const usage = await getUploadUsage(db);
  assert.ok(usage.reserved_bytes <= UPLOAD_QUOTA_BYTES);
  assert.equal(usage.quota_bytes,UPLOAD_QUOTA_BYTES);
  assert.equal(usage.links_last_hour,1);
});

test("expired unused links free reservations, but ambiguous writes remain reserved", async () => {
  await db.prepare("DELETE FROM uploads").run();
  const now = new Date();
  await db.prepare("INSERT INTO uploads (id, token_hash, ext, max_bytes, status, created_at, expires_at) VALUES (?, 'hash', 'png', ?, 'pending', ?, ?)")
    .bind("expired", 10 * MiB,now.toISOString(),new Date(now.getTime() - 1000).toISOString()).run();
  await db.prepare("INSERT INTO uploads (id, token_hash, ext, max_bytes, status, created_at, expires_at) VALUES (?, 'hash', 'png', ?, 'uploading', ?, ?)")
    .bind("uncertain", 20 * MiB,now.toISOString(),new Date(now.getTime() - 1000).toISOString()).run();
  const usage=await getUploadUsage(db);
  assert.equal(usage.estimated_stored_bytes,0);
  assert.equal(usage.reserved_bytes,20 * MiB);
  assert.equal(usage.links_last_hour,2);
});
