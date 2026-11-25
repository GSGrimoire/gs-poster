import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createPost, ensureSchema } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import { imagePreviewUrl } from "../src/image-preview.ts";
import { MAX_IMAGE_BYTES, openImageStream } from "../src/media.ts";
import { makeSession, SESSION_COOKIE } from "../src/session.ts";

const origin = "https://poster.test";
const bindings = { COOKIE_SECRET: "preview-test-only", ALLOWED_GITHUB_LOGINS: "test-owner", TIMEZONE: "Europe/Copenhagen" };
const first = "a".repeat(32);
const second = "b".repeat(32);
const upload = (id: string) => "upload://" + id + ".png";
const github = "https://raw.githubusercontent.com/example/art/main/photo.png";
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
let mf: Miniflare;
let db: D1Database;
let signedIn: HeadersInit;
let revoked: HeadersInit;

before(async () => {
  const out = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { handleWeb } from "./src/web.ts";
    export default { fetch(request, env) {
      if (request.headers.get("x-local-image-fixture") !== "transform") return handleWeb(request, env);
      const bytes = new Uint8Array(${JSON.stringify([...png])});
      const stream = new Response(bytes).body;
      const UPLOADS = { get: async () => ({ body: stream, size: bytes.length,
        arrayBuffer() { throw new Error("buffering is not allowed"); } }) };
      const IMAGES = { input(input) {
        if (input !== stream) throw new Error("private object stream was replaced");
        return { transform(options) {
          if (options.width !== 112 || options.height !== 112 || options.fit !== "scale-down")
            throw new Error("unexpected preview dimensions");
          return { async output(options) {
            if (options.format !== "image/webp" || options.quality !== 58 || options.anim !== false)
              throw new Error("unexpected preview format");
            return { response: () => new Response(input) };
          } };
        } };
      } };
      return handleWeb(request, { ...env, UPLOADS, IMAGES });
    } };
  ` }, bundle: true, format: "esm",
    platform: "neutral", target: "es2022", write: false, external: ["cloudflare:*", "node:*"],
    conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], logLevel: "silent" });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, cf: false,
    script: out.outputFiles[0].text, compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"], r2Buckets: ["UPLOADS"], bindings,
    outboundService: async (req: Request) => {
      assert.equal(req.url, github);
      assert.equal(req.headers.get("authorization"), null);
      return new Response(png, { headers: { "Content-Type": "text/plain" } });
    },
  }));
  db = await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
  const bucket = await mf.getR2Bucket("UPLOADS");
  await bucket.put(`uploads/${first}.png`, png, { httpMetadata: { contentType: "text/plain" } });
  await bucket.put(`uploads/${second}.png`, new Uint8Array([...png, 7]));
  signedIn = { Cookie: SESSION_COOKIE + "=" + await makeSession(bindings as Env, "test-owner") };
  revoked = { Cookie: SESSION_COOKIE + "=" + await makeSession(bindings as Env, "former-editor") };
});
after(async () => { await mf?.dispose(); });

async function draft(images: string[]) {
  return createPost(db, { message: "Preview fixture", images,
    scheduled_at: null, created_by: "test-owner" });
}
function get(path: string, headers: HeadersInit = signedIn) {
  return mf.dispatchFetch(origin + path, { headers, redirect: "manual" });
}

test("the real Worker streams private upload and GitHub images inside the current session wall", async () => {
  const post = await draft([upload(first), github]);
  const path = imagePreviewUrl(post.id, 0, upload(first), "facebook");
  for (const headers of [{}, revoked]) {
    const response = await get(path, headers);
    assert.equal(response.status, 302);
    assert.match(response.headers.get("Location")!, /^\/login\?/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  const response = await get(path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Cache-Control"), "private, max-age=86400, immutable");
  assert.equal(response.headers.get("Vary"), "Cookie");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  const mutable = await get(imagePreviewUrl(post.id, 1, github, "facebook"));
  assert.equal(mutable.status, 200);
  assert.equal(mutable.headers.get("Cache-Control"), "private, max-age=300");
  assert.equal(mutable.headers.get("Content-Type"), "image/png");
  assert.deepEqual(new Uint8Array(await mutable.arrayBuffer()), png);
});

test("a slot reorder changes the long-lived URL and an old version cannot select the old object", async () => {
  const post = await draft([upload(first), upload(second)]);
  const previous = imagePreviewUrl(post.id, 0, upload(first), "facebook");
  const previousResponse = await get(previous);
  assert.equal(previousResponse.status, 200);
  await previousResponse.arrayBuffer();
  await db.prepare("UPDATE posts SET images = ? WHERE id = ?").bind(JSON.stringify([upload(second), upload(first)]), post.id).run();
  const stale = await get(previous);
  assert.equal(stale.status, 404);
  assert.equal(stale.headers.get("Cache-Control"), "no-store");
  const current = await get(imagePreviewUrl(post.id, 0, upload(second), "facebook"));
  assert.equal(current.headers.get("Cache-Control"), "private, max-age=86400, immutable");
  assert.deepEqual(new Uint8Array(await current.arrayBuffer()), new Uint8Array([...png, 7]));
  const legacy = await get(`/media/${post.id}/0?platform=facebook`);
  assert.equal(legacy.headers.get("Cache-Control"), "private, max-age=300");
  await legacy.arrayBuffer();
});

test("the thumbnail transformer receives the private object stream directly", async () => {
  const post = await draft([upload(first)]);
  const path = imagePreviewUrl(post.id, 0, upload(first), "facebook", true);
  const response = await get(path, { ...signedIn, "x-local-image-fixture": "transform" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/webp");
  assert.equal(response.headers.get("Cache-Control"), "private, max-age=86400, immutable");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
});

test("an oversized private image is refused from object metadata", async () => {
  let cancelled = false;
  const env = { UPLOADS: { async get() {
    return { size: MAX_IMAGE_BYTES + 1, body: new ReadableStream({ cancel() { cancelled = true; } }),
      arrayBuffer() { assert.fail("buffering is not allowed"); } };
  } } } as unknown as Env;
  await assert.rejects(openImageStream(env, upload(first)), /exceeds 10 MB/);
  assert.equal(cancelled, true);
});

test("the editor and read-only review link thumbnails to the original; unavailable transforms fall back privately", async () => {
  const post = await draft([upload(first)]);
  const full = imagePreviewUrl(post.id, 0, upload(first), "facebook");
  const preview = imagePreviewUrl(post.id, 0, upload(first), "facebook", true);
  for (const status of ["draft", "published"]) {
    await db.prepare("UPDATE posts SET status = ? WHERE id = ?").bind(status, post.id).run();
    const response = await get("/post/" + post.id);
    assert.equal(response.status, 200);
    const markup = (await response.text()).replaceAll("&amp;", "&").replaceAll("&#38;", "&");
    assert.ok(markup.includes(`href="${full}"`));
    assert.ok(markup.includes(`src="${preview}"`));
  }
  const fallback = await get(preview);
  assert.equal(fallback.status, 302);
  assert.equal(fallback.headers.get("Location"), full);
  assert.equal(fallback.headers.get("Cache-Control"), "no-store");
});
