import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_IMAGES, FACEBOOK_IMAGE_BATCH_SIZE, nextFacebookImageBatch } from "../src/validate.ts";
import { checkBluesky, publishBluesky, blueskyRecordKey } from "../src/bluesky.ts";
import { checkVideoUrl, fetchVideo, INITIAL_VIDEO_MAX_BYTES } from "../src/video.ts";
import type { Env } from "../src/env.ts";

const videoUrl = "https://raw.githubusercontent.com/GoofySpook/GSImageLibrary/main/teaser.mp4";
const patreon = { url: "https://www.patreon.com/posts/free-chapter-123", title: "Free Chapter", description: "A free release." };

test("Facebook batch and maximum bounds", () => {
  assert.equal(MAX_IMAGES, 80);
  assert.equal(FACEBOOK_IMAGE_BATCH_SIZE, 8);
  assert.equal(Math.ceil(MAX_IMAGES / FACEBOOK_IMAGE_BATCH_SIZE), 10);
  const indices: number[] = [];
  let current = 0;
  while (current < MAX_IMAGES) {
    const { start, end } = nextFacebookImageBatch(current, MAX_IMAGES);
    assert.ok(end - start <= 8);
    indices.push(...Array.from({ length: end - start }, (_, n) => n + start));
    current = end;
  }
  assert.deepEqual(indices, Array.from({ length: 80 }, (_, n) => n));
  assert.deepEqual(nextFacebookImageBatch(76, 80), { start: 76, end: 80 });
  assert.throws(() => nextFacebookImageBatch(0, 81), /Invalid Facebook/);
});

test("Bluesky videos require a safe MP4 source and descriptive alt", () => {
  assert.equal(checkVideoUrl(videoUrl), null);
  assert.ok(checkVideoUrl("https://example.net/file.mp4"));
  assert.ok(checkVideoUrl("http://raw.githubusercontent.com/GoofySpook/GSImageLibrary/main/teaser.mp4"));
  assert.ok(checkBluesky({ caption: "New trailer", images: [{ url: videoUrl.replace(".mp4", ".png"), alt: "Cover art" }], video: { url: videoUrl, alt: "A sweeping view of the ruins" }, patreon: null })
    .some((x) => x.includes("both gallery images and a video")));
  assert.ok(checkBluesky({ caption: "New trailer", images: [], video: { url: videoUrl, alt: "" }, patreon: null })
    .some((x) => x.includes("accessibility")));
  assert.equal(INITIAL_VIDEO_MAX_BYTES, 20_000_000);
});

test("Bluesky video creates a video post and separate linked Patreon card", async () => {
  const previous = globalThis.fetch;
  const writes: Array<any> = [];
  const mp4 = Uint8Array.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0]);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("createSession")) return Response.json({ did: "did:plc:test", accessJwt: "demo-only" });
    if (url.includes("raw.githubusercontent.com")) return new Response(mp4, { status: 200 });
    if (url.includes("uploadBlob")) {
      assert.equal((init?.headers as Record<string, string>)["Content-Type"], "video/mp4");
      return Response.json({ blob: { $type: "blob", ref: { $link: "testcid" }, mimeType: "video/mp4", size: mp4.length } });
    }
    if (url.includes("createRecord")) {
      const body = JSON.parse(String(init?.body));
      writes.push(body);
      return Response.json({ uri: "at://did:plc:test/app.bsky.feed.post/" + body.rkey, cid: "cid-" + body.rkey });
    }
    throw new Error("Unexpected request: " + url);
  };
  try {
    const env = { BSKY_HANDLE: "account.bsky.social", BSKY_APP_PASSWORD: "test" } as Env;
    const published = await publishBluesky(env, "p_mvrslvbab2230330c1", {
      caption: "A look inside the new release",
      images: [], video: { url: videoUrl, alt: "A view across a misty fantasy battlefield" }, patreon,
    });
    assert.equal(writes.length, 2);
    assert.equal(writes[0].record.embed.$type, "app.bsky.embed.video");
    assert.equal(writes[0].record.embed.alt, "A view across a misty fantasy battlefield");
    assert.equal(writes[1].record.embed.$type, "app.bsky.embed.external");
    assert.deepEqual(writes[1].record.reply.root, { uri: writes[0].record.reply?.root?.uri ?? "at://did:plc:test/app.bsky.feed.post/" + blueskyRecordKey("p_mvrslvbab2230330c1"), cid: "cid-" + blueskyRecordKey("p_mvrslvbab2230330c1") });
    assert.equal(published.cardUri, "at://did:plc:test/app.bsky.feed.post/gspcardvideotest");
  } finally { globalThis.fetch = previous; }
});

test("Reject video payload that is not genuine MP4", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response("version https://git-lfs.github.com/spec/v1", { status: 200 });
  try {
    await assert.rejects(fetchVideo({} as Env, videoUrl), /non-MP4/);
  } finally { globalThis.fetch = previous; }
});
