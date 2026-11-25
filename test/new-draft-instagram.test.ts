import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { attachDraftImage, attachDraftVideo, getPost, tiktokMedia, type Post } from "../src/db.ts";
import { defaultItem, INSTAGRAM_MAX_ITEMS } from "../src/instagram.ts";
import { csrfToken, makeSession, SESSION_COOKIE } from "../src/session.ts";
import { createUpload, handleUploadPut } from "../src/upload.ts";
import type { Env } from "../src/env.ts";

const ORIGIN = "https://poster.test";
const LOGIN = "GSGrimoire";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/e5cAAAAASUVORK5CYII=", "base64");
const bindings = {
  COOKIE_SECRET: "local-instagram-composer-cookie-secret",
  ALLOWED_GITHUB_LOGINS: LOGIN,
  TIMEZONE: "Europe/Copenhagen",
  IG_USER_ID: "123456",
  FB_PAGE_TOKEN: "local-fixture-no-provider-access",
};
let mf: Miniflare;
let env: Env;
let csrf: string;
let cookie: string;
let outbound = 0;

before(async () => {
  const bundle = await build({
    entryPoints: ["test/fixtures/web-entry.ts"], bundle: true, format: "esm",
    platform: "neutral", target: "es2022", write: false, external: ["cloudflare:*", "node:*"],
    conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], logLevel: "silent",
  });
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, cf: false, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"], r2Buckets: ["UPLOADS"], bindings,
    outboundService: async () => { outbound++; return new Response("Provider traffic blocked", { status: 599 }); },
  }));
  env = { ...bindings, DB: await mf.getD1Database("DB"), UPLOADS: await mf.getR2Bucket("UPLOADS") } as unknown as Env;
  const raw = await makeSession(env, LOGIN);
  csrf = await csrfToken(env, { login: LOGIN, raw });
  cookie = SESSION_COOKIE + "=" + raw;
});

after(async () => {
  await mf?.dispose();
  assert.equal(outbound, 0);
});

function saveForm(fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return mf.dispatchFetch(ORIGIN + "/new", {
    method: "POST", redirect: "manual",
    body: new URLSearchParams({ csrf, instagram: "1", ig_caption: "Into the grotto #fantasy", content_kind: "images", ...fields }).toString(),
    headers: { Cookie: cookie, Origin: ORIGIN, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", ...headers },
  });
}

async function draft(fields: Record<string, string> = {}): Promise<Post> {
  const response = await saveForm(fields);
  assert.equal(response.status, 200, await response.clone().text());
  const { id } = await response.json() as { id: string };
  return (await getPost(env.DB, id))!;
}

function media(post: Post, action: string, fields: Record<string, unknown>, headers: Record<string, string> = {}) {
  return mf.dispatchFetch(ORIGIN + "/post/" + post.id + "/" + action, {
    method: "POST", redirect: "manual", body: JSON.stringify({ csrf, ...fields }),
    headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json", ...headers },
  });
}

function attach(post: Post, reference: string, fields: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return media(post, "attach-image", { reference, instagram: true, expected_updated_at: post.updated_at, ...fields }, headers);
}

async function store(uploadUrl: string) {
  const response = await handleUploadPut(new Request(uploadUrl, {
    method: "PUT", body: PNG, headers: { "Content-Length": String(PNG.length) },
  }), env);
  assert.equal(response.status, 200, await response.text());
}

async function photo(post: Post, filename: string) {
  const response = await media(post, "upload-link", { filename });
  assert.equal(response.status, 200, await response.clone().text());
  const grant = await response.json() as { reference: string; upload_url: string };
  await store(grant.upload_url);
  return grant.reference;
}

async function stillDraft(post: Post) {
  assert.equal(post.status, "draft");
  assert.equal(post.approved_at, null);
  assert.equal(await env.DB.prepare("SELECT post_id FROM instagram_jobs WHERE post_id=?").bind(post.id).first(), null);
}

test("New draft accepts Instagram alone, keeps its caption separate, and never queues it", async () => {
  const p = await draft({ message: "Facebook text is separate" });
  assert.equal(p.facebook_enabled, false);
  assert.equal(p.bluesky, null);
  assert.equal(p.tiktok_enabled, false);
  assert.equal(p.instagram?.caption, "Into the grotto #fantasy");
  assert.equal(p.instagram?.frame, "4:5");
  assert.deepEqual(p.instagram?.items, []);
  await stillDraft(p);

  const first = await photo(p, "first.png"), second = await photo(p, "second.png");
  const response = await attach(p, second);
  assert.equal(response.status, 200, await response.clone().text());
  const current = (await getPost(env.DB, p.id))!;
  assert.equal((await attach(current, first)).status, 200);
  const updated = (await getPost(env.DB, p.id))!;
  assert.deepEqual(updated.instagram?.items, [defaultItem(second, "pad"), defaultItem(first, "pad")]);
  assert.deepEqual(updated.images, []);
  await stillDraft(updated);
  const path = "/media/" + p.id + "/1?platform=instagram";
  assert.equal((await mf.dispatchFetch(ORIGIN + path, { redirect: "manual" })).status, 302);
  const image = await mf.dispatchFetch(ORIGIN + path, { headers: { Cookie: cookie } });
  assert.equal(image.headers.get("Content-Type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
});

test("unselected, cross-site, unsigned, stale, incomplete and foreign photo requests are refused", async () => {
  assert.equal((await saveForm({}, { Cookie: "" })).status, 302);
  assert.equal((await saveForm({}, { Origin: "https://elsewhere.test" })).status, 403);
  assert.equal((await saveForm({ csrf: "wrong" })).status, 403);
  assert.match(await (await saveForm({ content_kind: "text" })).text(), /Instagram needs photos or a Reel/);
  assert.match(await (await saveForm({ ig_caption: "a".repeat(2201) })).text(), /Instagram allows 2200/);
  assert.match(await (await saveForm({ ig_caption: "#tag ".repeat(31) })).text(), /30 hashtags/);
  const noInstagram = await draft({ instagram: "0", facebook: "1", ig_caption: "ignored" });
  assert.equal(noInstagram.instagram, null);
  const p = await draft();
  const reference = await photo(p, "owned.png");
  assert.equal((await attach(noInstagram, reference)).status, 400);
  assert.equal((await attach(p, reference, {}, { Cookie: "" })).status, 302);
  assert.equal((await attach(p, reference, {}, { Origin: "https://elsewhere.test" })).status, 403);
  assert.equal((await attach(p, reference, { csrf: "wrong" })).status, 403);
  assert.equal((await attach(p, reference, { expected_updated_at: "1970-01-01T00:00:00.000Z" })).status, 409);
  const pending = await createUpload(env, ORIGIN, { filename: "pending.png", actor: LOGIN });
  assert.equal((await attach(p, pending.reference)).status, 400);
  const foreign = await createUpload(env, ORIGIN, { filename: "foreign.png", actor: "another-user" });
  await store(foreign.upload_url);
  assert.equal((await attach(p, foreign.reference)).status, 400);
  assert.deepEqual(await getPost(env.DB, p.id), p);
});

test("multi-platform upload writes only selected galleries and refuses duplicate or eleventh Instagram photos atomically", async () => {
  let post = await draft({ facebook: "1", bluesky: "1", tiktok: "1" });
  const first = await photo(post, "shared.png");
  const all = await attach(post, first, { facebook: true, bluesky: true, tiktok: true, alt: "A torch beside a door" });
  assert.equal(all.status, 200, await all.clone().text());
  post = (await getPost(env.DB, post.id))!;
  assert.deepEqual(post.images, [first]);
  assert.deepEqual(tiktokMedia(post).images, [first]);
  assert.deepEqual(post.bluesky?.images, [{ url: first, alt: "A torch beside a door" }]);
  assert.deepEqual(post.instagram?.items, [defaultItem(first, "pad")]);
  assert.equal((await attach(post, first, { facebook: true })).status, 409);
  assert.deepEqual(await getPost(env.DB, post.id), post);
  for (let index = 1; index < INSTAGRAM_MAX_ITEMS; index++) {
    const response = await attach(post, await photo(post, "carousel-" + index + ".png"));
    assert.equal(response.status, 200, await response.text());
    post = (await getPost(env.DB, post.id))!;
  }
  assert.equal(post.instagram?.items.length, INSTAGRAM_MAX_ITEMS);
  const extra = await photo(post, "extra.png");
  assert.equal((await attach(post, extra, { facebook: true })).status, 409);
  assert.deepEqual(await getPost(env.DB, post.id), post);
  assert.deepEqual(post.images, [first]);
  await stillDraft(post);
});

test("a losing photo upload cannot mutate sibling rows with the same next millisecond", async (t) => {
  const p = await draft({ facebook: "1", bluesky: "1" });
  const first = await photo(p, "winner.png"), second = await photo(p, "stale.png");
  t.mock.method(Date, "now", () => Date.parse(p.updated_at) + 1);
  assert.ok(await attachDraftImage(env.DB, p.id, first, "", true, false, p.updated_at));
  const winner = (await getPost(env.DB, p.id))!;
  assert.equal(await attachDraftImage(env.DB, p.id, second, "Stale", false, true, p.updated_at, false, true), null);
  const video = "upload://" + "a".repeat(32) + ".mp4";
  assert.equal(await attachDraftVideo(env.DB, p.id, video, "Stale", false, true, p.updated_at, false, true), null);
  assert.deepEqual(await getPost(env.DB, p.id), winner);
});

test("a draft Reel and an Instagram photo cannot occupy the same target", async () => {
  const p = await draft({ content_kind: "video", bluesky: "1" });
  const video = "upload://" + "a".repeat(32) + ".mp4";
  assert.ok(await attachDraftVideo(env.DB, p.id, video, "A short cave scene", false, true, p.updated_at, false, true));
  const saved = (await getPost(env.DB, p.id))!;
  assert.equal(saved.instagram?.video, video);
  assert.equal(saved.bluesky?.video?.url, video);
  const image = await photo(saved, "not-with-reel.png");
  assert.equal((await attach(saved, image)).status, 409);
  assert.deepEqual(await getPost(env.DB, p.id), saved);
  await stillDraft(saved);
});

test("an activity log failure returns the saved photo and version", async () => {
  const post = await draft();
  const reference = await photo(post, "audit-recovery.png");
  await env.DB.prepare(`CREATE TRIGGER audit_unavailable BEFORE INSERT ON audit
    WHEN NEW.action = 'draft-media-attached' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`).run();
  try {
    const response = await attach(post, reference);
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as { ok: boolean; updated_at: string; audit_warning: string };
    assert.equal(result.ok, true);
    assert.match(result.audit_warning, /could not be recorded/);
    const saved = (await getPost(env.DB, post.id))!;
    assert.equal(result.updated_at, saved.updated_at);
    assert.deepEqual(saved.instagram?.items, [defaultItem(reference, "pad")]);
    assert.equal((await attach(saved, reference)).status, 409);
  } finally {
    await env.DB.prepare("DROP TRIGGER audit_unavailable").run();
  }
});
