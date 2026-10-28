/**
 * Bluesky is published only after approval (or from the approved cron queue).
 * App passwords are used solely to create a short-lived session with bsky.social.
 */
import type { Env } from "./env.ts";
import type { BlueskyDraft } from "./db.ts";
import { checkImageUrl, fetchImage } from "./media.ts";
import { checkVideoUrl, fetchVideo } from "./video.ts";

const XRPC = "https://bsky.social/xrpc/";
export const BSKY_IMAGE_LIMIT = 1_950_000; // below the protocol's 2,000,000-byte limit
export const BSKY_IMAGE_COUNT = 4;
export const BSKY_TEXT_LIMIT = 300;

export function textLength(text: string): number {
  return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)].length;
}

export function validPatreonUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" &&
      (u.hostname === "patreon.com" || u.hostname === "www.patreon.com") &&
      u.pathname.startsWith("/posts/") && u.pathname.length > "/posts/".length &&
      !u.username && !u.password;
  } catch {
    return false;
  }
}

export function checkBluesky(draft: BlueskyDraft): string[] {
  const errors: string[] = [];
  if (!draft.caption.trim()) errors.push("Bluesky needs a caption.");
  if (textLength(draft.caption) > BSKY_TEXT_LIMIT) errors.push("Bluesky allows at most 300 characters (grapheme clusters).");
  if (new TextEncoder().encode(draft.caption).byteLength > 3000) errors.push("Bluesky caption is over its 3,000-byte limit.");
  if (draft.images.length > BSKY_IMAGE_COUNT) errors.push("Bluesky allows at most four images.");
  if (draft.video) {
    if (draft.images.length) errors.push("A Bluesky post cannot contain both gallery images and a video.");
    const videoError = checkVideoUrl(draft.video.url);
    if (videoError) errors.push(videoError);
    if (!draft.video.alt.trim()) errors.push("Bluesky video needs descriptive accessibility text.");
    if (textLength(draft.video.alt) > 1000) errors.push("Bluesky video description exceeds 1,000 characters.");
  }
  for (const [i, image] of draft.images.entries()) {
    const urlError = checkImageUrl(image.url);
    if (urlError) errors.push("Image " + (i + 1) + ": " + urlError);
    if (!image.alt.trim()) errors.push("Image " + (i + 1) + " is missing alternative text from the image library description.");
    if (textLength(image.alt) > 1000) errors.push("Image " + (i + 1) + " alternative text exceeds 1,000 characters.");
  }
  if (draft.patreon) {
    if (!validPatreonUrl(draft.patreon.url)) errors.push("The Bluesky card must link to a Patreon /posts/ page over HTTPS.");
    if (!draft.patreon.title.trim() || !draft.patreon.description.trim()) {
      errors.push("The Patreon card needs a title and a description.");
    }
  }
  return errors;
}

export interface PublishedBluesky {
  uri: string;
  cid: string;
  cardUri: string | null;
  permalink: string;
}

type Session = { did: string; accessJwt: string };
type RecordResult = { uri: string; cid: string };

async function api(path: string, init: RequestInit): Promise<any> {
  const res = await fetch(XRPC + path, init);
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new Error("Bluesky " + path + ": " + (data.message || data.error || "HTTP " + res.status));
  return data;
}

async function signIn(env: Env): Promise<Session> {
  if (!env.BSKY_HANDLE || !env.BSKY_APP_PASSWORD) throw new Error("Bluesky is not configured (BSKY_HANDLE and BSKY_APP_PASSWORD).");
  const data = await api("com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: env.BSKY_HANDLE, password: env.BSKY_APP_PASSWORD }),
  });
  if (!data.did || !data.accessJwt) throw new Error("Bluesky returned an incomplete session.");
  return { did: String(data.did), accessJwt: String(data.accessJwt) };
}

function bearer(session: Session): HeadersInit {
  return { Authorization: "Bearer " + session.accessJwt };
}

async function uploadImage(env: Env, session: Session, url: string): Promise<unknown> {
  if (!env.IMAGES) throw new Error("Cloudflare IMAGES binding is not configured.");
  const src = await fetchImage(env, url);
  const attempts = [
    { width: 2048, quality: 82 }, { width: 1600, quality: 76 },
    { width: 1280, quality: 70 }, { width: 960, quality: 62 },
    { width: 720, quality: 54 }, { width: 512, quality: 45 },
  ];
  for (const size of attempts) {
    const transformed = await env.IMAGES.input(new Blob([src.bytes]).stream())
      .transform({ width: size.width, fit: "scale-down" })
      .output({ format: "image/webp", quality: size.quality, anim: false });
    const bytes = await transformed.response().arrayBuffer();
    if (bytes.byteLength >= BSKY_IMAGE_LIMIT) continue;
    const uploaded = await api("com.atproto.repo.uploadBlob", {
      method: "POST",
      headers: { ...bearer(session), "Content-Type": "image/webp" },
      body: bytes,
    });
    if (!uploaded.blob) throw new Error("Bluesky did not return an image blob.");
    return uploaded.blob;
  }
  throw new Error("Image cannot be compressed below Bluesky's 2 MB limit.");
}

/** Stable record keys make retries safe even if Bluesky accepted a write but the response was lost. */
const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

/** AT Protocol feed post rkeys must be 13-character time identifiers (TIDs).
 * The GS Poster ID encodes creation milliseconds, which lets retries derive the
 * same key rather than creating duplicate records.
 */
export function blueskyRecordKey(id: string, card = false): string {
  const match = /^p_([0-9a-z]+)([0-9a-f]{10})$/.exec(id);
  if (!match) throw new Error("Invalid GS Poster post ID for Bluesky.");
  const millis = parseInt(match[1], 36);
  if (!Number.isSafeInteger(millis)) throw new Error("Invalid GS Poster creation timestamp.");
  const micros = BigInt(millis) * 1000n;
  // 10-bit deterministic clock component, with a separate value for reply cards.
  let hash = 0;
  for (const char of match[2]) hash = (Math.imul(hash, 33) ^ char.charCodeAt(0)) & 1023;
  const clock = (hash & 1022) | (card ? 1 : 0);
  let tid = (micros << 10n) | BigInt(clock);
  let encoded = "";
  for (let i = 0; i < 13; i++) {
    encoded = TID_ALPHABET[Number(tid & 31n)] + encoded;
    tid >>= 5n;
  }
  if (tid !== 0n) throw new Error("GS Poster timestamp is outside the TID range.");
  return encoded;
}

async function createRecord(session: Session, rkey: string, record: Record<string, unknown>): Promise<RecordResult> {
  let error: unknown;
  try {
    const created = await api("com.atproto.repo.createRecord", {
      method: "POST",
      headers: { ...bearer(session), "Content-Type": "application/json" },
      body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", rkey, record }),
    });
    if (created.uri && created.cid) return { uri: String(created.uri), cid: String(created.cid) };
    error = new Error("Bluesky did not return the published post identifier.");
  } catch (e) {
    error = e;
  }
  // Distinguish a lost response / existing record from a genuine failure.
  try {
    const found = await api("com.atproto.repo.getRecord?repo=" + encodeURIComponent(session.did) +
      "&collection=app.bsky.feed.post&rkey=" + encodeURIComponent(rkey), { method: "GET" });
    if (found.uri && found.cid) return { uri: String(found.uri), cid: String(found.cid) };
  } catch {
    // Original failure is the actionable one.
  }
  throw error;
}

export async function publishBluesky(env: Env, id: string, draft: BlueskyDraft): Promise<PublishedBluesky> {
  const errors = checkBluesky(draft);
  if (errors.length) throw new Error(errors.join(" "));
  const session = await signIn(env);
  const images: Array<{ image: unknown; alt: string }> = [];
  for (const media of draft.images) {
    images.push({ image: await uploadImage(env, session, media.url), alt: media.alt.trim() });
  }
  let videoBlob: unknown = undefined;
  if (draft.video) {
    // First stage support: Bluesky processes a direct blob asynchronously after publication.
    const bytes = await fetchVideo(env, draft.video.url);
    const uploaded = await api("com.atproto.repo.uploadBlob", {
      method: "POST", headers: { ...bearer(session), "Content-Type": "video/mp4" },
      body: bytes,
    });
    if (!uploaded.blob) throw new Error("Bluesky did not return a video blob.");
    videoBlob = uploaded.blob;
  }
  const embed = videoBlob
    ? { $type: "app.bsky.embed.video", video: videoBlob, alt: draft.video!.alt.trim() }
    : images.length
    ? { $type: "app.bsky.embed.images", images }
    : draft.patreon
      ? { $type: "app.bsky.embed.external", external: {
          uri: draft.patreon.url, title: draft.patreon.title, description: draft.patreon.description,
        } }
      : undefined;
  const main = await createRecord(session, blueskyRecordKey(id), {
    $type: "app.bsky.feed.post", text: draft.caption, createdAt: new Date().toISOString(),
    ...(embed ? { embed } : {}),
  });
  let cardUri: string | null = null;
  if ((images.length || videoBlob) && draft.patreon) {
    // Bluesky cannot hold a gallery/video and an external card in a single embed.
    // Post the card as a reply in the same thread.
    const card = await createRecord(session, blueskyRecordKey(id, true), {
      $type: "app.bsky.feed.post",
      text: "Free Patreon post",
      createdAt: new Date().toISOString(),
      reply: { root: main, parent: main },
      embed: {
        $type: "app.bsky.embed.external",
        external: {
          uri: draft.patreon.url, title: draft.patreon.title, description: draft.patreon.description,
        },
      },
    });
    cardUri = card.uri;
  }
  return {
    uri: main.uri, cid: main.cid, cardUri,
    permalink: "https://bsky.app/profile/" + encodeURIComponent(session.did) +
      "/post/" + blueskyRecordKey(id),
  };
}
