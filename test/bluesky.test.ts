import { test } from "node:test";
import assert from "node:assert/strict";
import { blueskyRecordKey, checkBluesky, publishBluesky, textLength, validPatreonUrl } from "../src/bluesky.ts";
import type { Env } from "../src/env.ts";

const url = "https://raw.githubusercontent.com/GoofySpook/GSImageLibrary/main/scenes/test.png";
const patreon = { url: "https://www.patreon.com/posts/free-adventure-1234", title: "Free Adventure", description: "A free encounter for your table." };

test("Bluesky caption length uses graphemes and enforces 300 characters", () => {
  assert.equal(textLength("a👨‍👩‍👧‍👦b"), 3);
  const base = { caption: "a".repeat(301), images: [], patreon: null };
  assert.ok(checkBluesky(base).some((e) => e.includes("300")));
  assert.deepEqual(checkBluesky({ ...base, caption: "A free encounter", images: [{ url, alt: "A torchlit ruin" }] }), []);
});

test("Bluesky requires valid Patreon links and description-based alt text", () => {
  assert.ok(validPatreonUrl(patreon.url));
  assert.equal(validPatreonUrl("https://patreon.com.evil.test/posts/free-123"), false);
  assert.equal(validPatreonUrl("http://www.patreon.com/posts/free-123"), false);
  assert.equal(validPatreonUrl("https://www.patreon.com/membership"), false);
  assert.ok(checkBluesky({ caption: "A new scene", images: [{ url, alt: "" }], patreon }).some((e) => e.includes("alternative text")));
  assert.ok(checkBluesky({ caption: "A", images: Array(5).fill({ url, alt: "Scene" }), patreon }).some((e) => e.includes("four")));
  const key = blueskyRecordKey("p_mvrslvbab2230330c1");
  assert.match(key, /^[234567a-z]{13}$/);
  assert.equal(blueskyRecordKey("p_mvrslvbab2230330c1"), key, "retry key must be stable");
  assert.match(blueskyRecordKey("p_mvrslvbab2230330c1", true), /^[234567a-z]{13}$/);
  assert.notEqual(blueskyRecordKey("p_mvrslvbab2230330c1", true), key);
  assert.throws(() => blueskyRecordKey("p_abc12"), /Invalid GS Poster post ID/);
});

test("publishes images and Patreon card as separate posts in one thread", async () => {
  const oldFetch = globalThis.fetch;
  const created: Array<any> = [];
  globalThis.fetch = async (input, init) => {
    const target = String(input);
    if (target.includes("createSession")) return Response.json({ did: "did:plc:example", accessJwt: "test-access" });
    if (target.includes("raw.githubusercontent.com")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    if (target.includes("uploadBlob")) return Response.json({ blob: { $type: "blob", ref: { $link: "bafktest" }, mimeType: "image/webp", size: 3 } });
    if (target.includes("createRecord")) {
      const body = JSON.parse(String(init?.body));
      created.push(body);
      return Response.json({ uri: "at://did:plc:example/app.bsky.feed.post/" + body.rkey, cid: "cid-" + body.rkey });
    }
    throw new Error("Unexpected request " + target);
  };
  try {
    const env = {
      BSKY_HANDLE: "gs.example.bsky.social",
      BSKY_APP_PASSWORD: "test-only",
      IMAGES: {
        input: () => ({
          transform: () => ({
            output: async () => ({ response: () => new Response(new Uint8Array([3, 4, 5])) }),
          }),
        }),
      },
    } as unknown as Env;
    const result = await publishBluesky(env, "p_mvrslvbab2230330c1", {
      caption: "Discover the free adventure.",
      images: [{ url, alt: "A stone bridge in a moonlit valley" }],
      patreon,
    });
    assert.equal(created.length, 2);
    assert.equal(created[0].rkey, blueskyRecordKey("p_mvrslvbab2230330c1"));
    assert.equal(created[0].record.embed.$type, "app.bsky.embed.images");
    assert.equal(created[0].record.embed.images[0].alt, "A stone bridge in a moonlit valley");
    assert.equal(created[1].rkey, blueskyRecordKey("p_mvrslvbab2230330c1", true));
    assert.equal(created[1].record.embed.$type, "app.bsky.embed.external");
    assert.deepEqual(created[1].record.reply.parent, {
      uri: "at://did:plc:example/app.bsky.feed.post/" + blueskyRecordKey("p_mvrslvbab2230330c1"),
      cid: "cid-gspabc12",
    });
    assert.ok(result.permalink.endsWith(blueskyRecordKey("p_mvrslvbab2230330c1")));
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("no-image Bluesky post includes the Patreon card in the main post", async () => {
  const oldFetch = globalThis.fetch;
  const records: any[] = [];
  globalThis.fetch = async (input, init) => {
    const target = String(input);
    if (target.includes("createSession")) return Response.json({ did: "did:plc:example", accessJwt: "test-access" });
    if (target.includes("createRecord")) {
      const body = JSON.parse(String(init?.body));
      records.push(body.record);
      return Response.json({ uri: "at://did:plc:example/app.bsky.feed.post/gsp123", cid: "cid123" });
    }
    throw new Error("Unexpected request: " + target);
  };
  try {
    await publishBluesky({ BSKY_HANDLE: "test", BSKY_APP_PASSWORD: "test" } as Env, "p_mvrslvbab2230330c1", {
      caption: "Read this free encounter", images: [], patreon,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].embed.$type, "app.bsky.embed.external");
  } finally { globalThis.fetch = oldFetch; }
});
