// Instagram publishing through the real web router in workerd: the approval
// card only offers Instagram once it is connected, approval needs the PIN and
// an explicit consent tick, the job controls need the PIN, and the public
// media path refuses unknown links. No request leaves the test.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createPost, ensureSchema, getPost, saveEditorDraft, type EditorDraft } from "../src/db.ts";
import { defaultItem } from "../src/instagram.ts";
import { ensureInstagramJobs, getInstagramJob, queueInstagramOnApproval } from "../src/instagram-publish.ts";
import { csrfToken, makeSession, SESSION_COOKIE, type Session } from "../src/session.ts";
import type { Env } from "../src/env.ts";

const ORIGIN = "https://gs-poster.test";
const SECRET = "instagram-route-test-cookie-secret";
const PIN = "975310"; // test-only value
const IG_ID = "17841400000000002";
const signer = { COOKIE_SECRET: SECRET, ALLOWED_GITHUB_LOGINS: "gsgrimoire" } as Env;
const IMG = (n: number) => `https://raw.githubusercontent.com/GoofySpook/GSImageLibrary/main/test/${n}.png`;
let script: string;

async function boot(bindings: Record<string, string>) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, cf: false, script,
    compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"], r2Buckets: ["UPLOADS"],
    bindings: { COOKIE_SECRET: SECRET, ALLOWED_GITHUB_LOGINS: "gsgrimoire", APPROVE_PIN: PIN, TIMEZONE: "Europe/Copenhagen", ...bindings } }));
  const db = await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
  await ensureInstagramJobs(db);
  return { mf, db };
}
// ensureSchema caches per process, so one workerd instance with Instagram
// connected. The not-connected plan is covered in instagram-publish.test.ts.
let on: Awaited<ReturnType<typeof boot>>;
before(async () => {
  const out = await build({ entryPoints: ["test/fixtures/web-entry.ts"], bundle: true, format: "esm",
    platform: "neutral", target: "es2022", write: false, external: ["cloudflare:*", "node:*"],
    conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], logLevel: "silent" });
  script = out.outputFiles[0].text;
  on = await boot({ FB_PAGE_ID: "123", FB_PAGE_TOKEN: "test-only-token", IG_USER_ID: IG_ID });
});
after(async () => { await on?.mf.dispose(); });

function editorDraft(p: any): EditorDraft {
  return { message: p.message, tiktok_caption: null, images: p.images, tiktok_images: p.tiktok_images, video: null,
    tiktok_video: null, facebook_enabled: true, tiktok_enabled: false, scheduled_at: null, label: p.label, release: p.release,
    bluesky_enabled: false, instagram_enabled: true } as EditorDraft;
}
async function draft(db: D1Database) {
  const p = await createPost(db, { message: "Cave.", label: "Cave", release: null, images: [IMG(1), IMG(2)],
    video: null, created_by: "test", scheduled_at: null } as any);
  assert.ok(await saveEditorDraft(db, p.id, p.updated_at, editorDraft(p), null,
    { caption: "Into the cave #dnd", frame: "4:5", items: [defaultItem(IMG(1)), defaultItem(IMG(2))] }));
  return (await getPost(db, p.id))!;
}
async function session() {
  const raw = await makeSession(signer, "GSGrimoire");
  return { raw, csrf: await csrfToken(signer, { login: "GSGrimoire", raw } as Session) };
}
async function post(mf: Miniflare, path: string, fields: Record<string, string>, o: { origin?: string } = {}) {
  const s = await session();
  return mf.dispatchFetch(ORIGIN + path, { method: "POST", redirect: "manual", body: new URLSearchParams({ csrf: s.csrf, ...fields }).toString(),
    headers: { Origin: o.origin ?? ORIGIN, "Sec-Fetch-Site": o.origin ? "cross-site" : "same-origin",
      "Content-Type": "application/x-www-form-urlencoded", Cookie: SESSION_COOKIE + "=" + s.raw } });
}
async function page(mf: Miniflare, path: string) {
  const s = await session();
  return (await mf.dispatchFetch(ORIGIN + path, { headers: { Cookie: SESSION_COOKIE + "=" + s.raw }, redirect: "manual" })).text();
}

test("the approval card offers Instagram once it is connected", async () => {
  const b = await draft(on.db);
  const ready = await page(on.mf, "/post/" + b.id);
  assert.match(ready, /name="target_instagram" value="1" checked/);
  assert.match(ready, /name="confirm_instagram" value="1" required/);
  assert.match(ready, /Instagram · 2-photo carousel/);
});

test("approving Instagram needs the PIN and the explicit consent tick", async () => {
  const p = await draft(on.db);
  const base = { expected_updated_at: p.updated_at, target_instagram: "1", confirm_instagram: "1" };
  const wrong = await post(on.mf, `/post/${p.id}/approve`, { ...base, pin: "000000" });
  assert.equal(wrong.status, 403);
  assert.equal(await getInstagramJob(on.db, p.id), null);
  const noConsent = await post(on.mf, `/post/${p.id}/approve`, { expected_updated_at: p.updated_at, target_instagram: "1", pin: PIN });
  assert.equal(noConsent.status, 400);
  assert.match(await noConsent.text(), /published automatically/);
  assert.equal(await getInstagramJob(on.db, p.id), null);
  const crossSite = await post(on.mf, `/post/${p.id}/approve`, { ...base, pin: PIN }, { origin: "https://evil.example" });
  assert.equal(crossSite.status, 403);
  assert.equal(await getInstagramJob(on.db, p.id), null);
});

test("cancelling an approved Instagram job needs the PIN and is shown in the card", async () => {
  const p = await draft(on.db);
  await queueInstagramOnApproval({ DB: on.db, FB_PAGE_TOKEN: "t", IG_USER_ID: IG_ID } as Env, p.id, p.updated_at,
    new Date(Date.now() + 3600_000), "gsgrimoire");
  const html = await page(on.mf, "/post/" + p.id);
  assert.match(html, /Approved, waiting for its time/);
  assert.match(html, /action="\/post\/[a-z0-9_]+\/instagram-cancel"/);
  assert.doesNotMatch(html, /name="target_instagram"/, "no second approval while a job exists");
  const wrong = await post(on.mf, `/post/${p.id}/instagram-cancel`, { pin: "111111" });
  assert.equal(wrong.status, 403);
  assert.equal((await getInstagramJob(on.db, p.id))!.status, "scheduled");
  const ok = await post(on.mf, `/post/${p.id}/instagram-cancel`, { pin: PIN });
  assert.equal(ok.status, 200);
  assert.equal((await getInstagramJob(on.db, p.id))!.status, "cancelled");
});

test("closing an unclear result needs the owner's 'I checked Instagram' tick as well as the PIN", async () => {
  const p = await draft(on.db);
  await queueInstagramOnApproval({ DB: on.db, FB_PAGE_TOKEN: "t", IG_USER_ID: IG_ID } as Env, p.id, p.updated_at, new Date(), "gsgrimoire");
  await on.db.prepare("UPDATE instagram_jobs SET status = 'failed', ambiguous = 1, error = 'unclear' WHERE post_id = ?").bind(p.id).run();
  const noTick = await post(on.mf, `/post/${p.id}/instagram-close`, { pin: PIN });
  assert.equal(noTick.status, 400);
  assert.equal((await getInstagramJob(on.db, p.id))!.status, "failed");
  const retry = await post(on.mf, `/post/${p.id}/instagram-retry`, { pin: PIN });
  assert.equal(retry.status, 409, "an unclear send cannot be retried directly");
  const ok = await post(on.mf, `/post/${p.id}/instagram-close`, { pin: PIN, confirmed_not_on_instagram: "1" });
  assert.equal(ok.status, 200);
  assert.equal((await getInstagramJob(on.db, p.id))!.status, "cancelled");
});

test("the public media path needs no session but refuses unknown links", async () => {
  for (const path of ["/instagram/media/" + "b".repeat(43) + ".jpg", "/instagram/media/short.jpg", "/instagram/media/x.png"]) {
    const res = await on.mf.dispatchFetch(ORIGIN + path, { redirect: "manual" });
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  }
});

// ---------------------------------------------------------------- review #83: successful approvals

// Private uploads in a local R2 bucket, so approval's media check needs no network.
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
async function privatePhotos(n: number) {
  const bucket = await on.mf.getR2Bucket("UPLOADS");
  const refs: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID().replace(/-/g, "");
    await bucket.put(`uploads/${id}.png`, PNG);
    refs.push(`upload://${id}.png`);
  }
  return refs;
}
async function draftWith(refs: string[], facebook: boolean, scheduledAt: string | null) {
  const p = await createPost(on.db, { message: "Cave.", label: "Cave", release: null, images: refs, video: null,
    created_by: "test", scheduled_at: scheduledAt } as any);
  assert.ok(await saveEditorDraft(on.db, p.id, p.updated_at, { ...editorDraft(p), facebook_enabled: facebook, scheduled_at: scheduledAt }, null,
    { caption: "Into the cave #dnd", frame: "4:5", items: refs.map((r) => defaultItem(r)) }));
  return (await getPost(on.db, p.id))!;
}

test("a signed-in approval with the PIN queues an Instagram-only post, and a second approval is refused", async () => {
  const p = await draftWith(await privatePhotos(2), false, null);
  const res = await post(on.mf, `/post/${p.id}/approve`, { expected_updated_at: p.updated_at, target_instagram: "1", confirm_instagram: "1", pin: PIN });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Instagram: approved, posts within a few minutes/);
  const job = (await getInstagramJob(on.db, p.id))!;
  assert.equal(job.status, "scheduled");
  assert.equal(job.kind, "CAROUSEL");
  assert.equal(job.items.length, 2);
  assert.ok(Math.abs(Date.parse(job.due_at) - Date.now()) < 60_000, "no time means now");
  const after = (await getPost(on.db, p.id))!;
  assert.equal(after.status, "draft", "an Instagram-only approval leaves the post itself a draft");
  const again = await post(on.mf, `/post/${p.id}/approve`, { expected_updated_at: after.updated_at, target_instagram: "1", confirm_instagram: "1", pin: PIN });
  assert.equal(again.status, 400);
  assert.match(await again.text(), /already has an approved job/);
});

test("one approval queues Instagram and the Facebook photo post together, on the same time", async () => {
  const at = new Date(Date.now() + 2 * 86400_000);
  at.setUTCSeconds(0, 0);
  const p = await draftWith(await privatePhotos(2), true, at.toISOString());
  const res = await post(on.mf, `/post/${p.id}/approve`, { expected_updated_at: p.updated_at,
    target_facebook: "1", target_instagram: "1", confirm_instagram: "1", pin: PIN });
  const html = await res.text();
  assert.equal(res.status, 200, html.slice(0, 400));
  assert.match(html, /Instagram: approved, posts at/);
  const job = (await getInstagramJob(on.db, p.id))!;
  assert.equal(job.status, "scheduled");
  assert.equal(job.due_at, at.toISOString());
  const after = (await getPost(on.db, p.id))!;
  assert.ok(after.approved_at, "Facebook was claimed by the same approval");
  assert.equal(after.status, "publishing", "Facebook photo posts go through the cron queue");
});

// ---------------------------------------------------------------- review #83: F4 frozen approved jobs

async function approvedIgOnly(at: Date | null) {
  const p = await draftWith(await privatePhotos(2), false, at ? at.toISOString() : null);
  await queueInstagramOnApproval({ DB: on.db, FB_PAGE_TOKEN: "t", IG_USER_ID: IG_ID } as Env, p.id, p.updated_at, at ?? new Date(), "gsgrimoire");
  return (await getPost(on.db, p.id))!;
}
const save = (p: { id: string; updated_at: string }, extra: Record<string, string>) =>
  post(on.mf, `/post/${p.id}/save`, { expected_updated_at: p.updated_at, auto: "1", message: "Cave.", p_instagram: "1",
    ig_caption: "Into the cave #dnd", ...extra });

test("F4: a PIN-free save cannot move the time of an approved Instagram post or switch Instagram off", async () => {
  const at = new Date(Date.now() + 2 * 86400_000); at.setUTCSeconds(0, 0);
  const p = await approvedIgOnly(at);
  const html = await page(on.mf, "/post/" + p.id);
  assert.match(html, /This approved Instagram post is frozen/);
  const moved = await save(p, { when: "2030-01-01T18:00" });
  assert.equal(moved.status, 409);
  assert.match(await moved.text(), /approved for Instagram, so its time is locked/);
  const off = await save(p, { p_instagram: "0", p_facebook: "1" });
  assert.equal(off.status, 409);
  assert.match(await off.text(), /cannot be switched off here/);
  let cur = (await getPost(on.db, p.id))!;
  assert.equal(cur.scheduled_at, at.toISOString(), "the post time did not move");
  assert.ok(cur.instagram, "Instagram is still on");
  // Text edits still save, and do not change what was approved.
  const text = await save(cur, { ig_caption: "Edited after approval #dnd" });
  assert.equal(text.status, 200, await text.clone().text());
  cur = (await getPost(on.db, p.id))!;
  assert.equal(cur.instagram!.caption, "Edited after approval #dnd");
  const job = (await getInstagramJob(on.db, p.id))!;
  assert.equal(job.caption, "Into the cave #dnd", "the approved caption is frozen");
  assert.equal(job.due_at, at.toISOString(), "the approved time is unchanged");
});

test("F4: a post whose Instagram job may still publish cannot be rejected; after the PIN cancel it can", async () => {
  const p = await approvedIgOnly(new Date(Date.now() + 86400_000));
  const rejected = await post(on.mf, `/post/${p.id}/reject`, { reason: "no" });
  assert.equal(rejected.status, 409);
  assert.match(await rejected.text(), /cannot be rejected/);
  assert.equal((await getPost(on.db, p.id))!.status, "draft");
  assert.equal((await post(on.mf, `/post/${p.id}/instagram-cancel`, { pin: PIN })).status, 200);
  const after = await post(on.mf, `/post/${p.id}/reject`, { reason: "no" });
  assert.equal(after.status, 302);
  assert.equal((await getPost(on.db, p.id))!.status, "rejected");
});

test("F4: a mixed approval leaves no PIN-free way to change the post or reject it", async () => {
  const at = new Date(Date.now() + 2 * 86400_000); at.setUTCSeconds(0, 0);
  const p = await draftWith(await privatePhotos(2), true, at.toISOString());
  assert.equal((await post(on.mf, `/post/${p.id}/approve`, { expected_updated_at: p.updated_at,
    target_facebook: "1", target_instagram: "1", confirm_instagram: "1", pin: PIN })).status, 200);
  const cur = (await getPost(on.db, p.id))!;
  const res = await save(cur, { when: "2030-01-01T18:00", p_facebook: "1" });
  assert.equal(res.status, 409);
  assert.equal((await post(on.mf, `/post/${p.id}/reject`, { reason: "no" })).status, 409);
  assert.equal((await getPost(on.db, p.id))!.scheduled_at, at.toISOString());
  assert.equal((await getInstagramJob(on.db, p.id))!.due_at, at.toISOString());
});
