/**
 * Facebook Graph API calls for one Page. The Page token never leaves this file
 * except inside requests to graph.facebook.com.
 */
import type { Env } from "./env.ts";
import type { ImageBytes } from "./media.ts";

export class FacebookError extends Error {
  readonly code?: number;
  readonly status?: number;
  constructor(message: string, code?: number, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function base(env: Env): string {
  // Local tests only: a mock Graph API on 127.0.0.1. Anything else is ignored.
  if (env.GRAPH_BASE_URL?.startsWith("http://127.0.0.1:")) return env.GRAPH_BASE_URL;
  return `https://graph.facebook.com/${env.GRAPH_VERSION || "v24.0"}`;
}

function need(env: Env): { pageId: string; token: string } {
  if (!env.FB_PAGE_ID || !env.FB_PAGE_TOKEN) throw new FacebookError("Facebook is not set up yet: FB_PAGE_ID and FB_PAGE_TOKEN secrets are missing.");
  return { pageId: env.FB_PAGE_ID, token: env.FB_PAGE_TOKEN };
}

async function appSecretProof(env: Env, token: string): Promise<string | null> {
  if (!env.FB_APP_SECRET) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.FB_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function authParams(env: Env, token: string): Promise<Record<string, string>> {
  const proof = await appSecretProof(env, token);
  return proof ? { access_token: token, appsecret_proof: proof } : { access_token: token };
}

async function parse(res: Response): Promise<any> {
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok || body?.error) {
    const e = body?.error ?? {};
    const msg = e.error_user_msg || e.message || `HTTP ${res.status}`;
    throw new FacebookError(`Facebook said: ${msg}`, e.code, res.status);
  }
  return body;
}

async function get(env: Env, path: string, params: Record<string, string> = {}): Promise<any> {
  const { token } = need(env);
  const q = new URLSearchParams({ ...params, ...(await authParams(env, token)) });
  return parse(await fetch(`${base(env)}/${path}?${q}`));
}

async function post(env: Env, path: string, body: URLSearchParams | FormData): Promise<any> {
  const { token } = need(env);
  for (const [k, v] of Object.entries(await authParams(env, token))) body.set(k, v);
  return parse(await fetch(`${base(env)}/${path}`, { method: "POST", body }));
}

/** Upload a photo without publishing it, so it can be attached to a feed post. */
export async function uploadUnpublishedPhoto(env: Env, img: ImageBytes, forScheduledPost: boolean): Promise<string> {
  const { pageId } = need(env);
  const form = new FormData();
  form.set("source", new Blob([img.bytes], { type: img.type }), img.name);
  form.set("published", "false");
  // Photos attached to a scheduled post must be uploaded as temporary.
  if (forScheduledPost) form.set("temporary", "true");
  const res = await post(env, `${pageId}/photos`, form);
  if (!res.id) throw new FacebookError("Facebook accepted the photo but returned no id.");
  return String(res.id);
}

export interface FeedPostInput {
  message: string;
  link?: string | null;
  mediaIds: string[];
  /** Unix seconds; omitted = publish now. */
  scheduledUnix?: number;
}

export async function createFeedPost(env: Env, input: FeedPostInput): Promise<string> {
  const { pageId } = need(env);
  const body = new URLSearchParams();
  if (input.message) body.set("message", input.message);
  if (input.link && input.mediaIds.length === 0) body.set("link", input.link);
  input.mediaIds.forEach((id, i) => body.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
  if (input.scheduledUnix) {
    body.set("published", "false");
    body.set("scheduled_publish_time", String(input.scheduledUnix));
  }
  const res = await post(env, `${pageId}/feed`, body);
  if (!res.id) throw new FacebookError("Facebook accepted the post but returned no id.");
  return String(res.id);
}

export interface PostInfo {
  is_published?: boolean;
  permalink_url?: string;
  scheduled_publish_time?: number;
  message?: string;
}

/** Returns null when the post no longer exists (deleted in Business Suite). */
export async function getPostInfo(env: Env, fbPostId: string): Promise<PostInfo | null> {
  try {
    return await get(env, fbPostId, { fields: "is_published,permalink_url,scheduled_publish_time,message" });
  } catch (e) {
    if (e instanceof FacebookError && (e.code === 100 || e.status === 404)) return null;
    throw e;
  }
}

export async function deleteFbPost(env: Env, fbPostId: string): Promise<void> {
  const { token } = need(env);
  const q = new URLSearchParams(await authParams(env, token));
  await parse(await fetch(`${base(env)}/${fbPostId}?${q}`, { method: "DELETE" }));
}

/**
 * Update a native Facebook schedule in place. Do not create a duplicate post.
 * Check its current state and verify the result with a read-back.
 */
export async function rescheduleFbPost(
  env: Env, fbPostId: string, previousUnix: number, nextUnix: number,
): Promise<void> {
  const before = await getPostInfo(env, fbPostId);
  if (!before || before.is_published !== false || !before.scheduled_publish_time) {
    throw new FacebookError("Facebook no longer confirms this post is scheduled; refresh before editing.");
  }
  if (Math.abs(before.scheduled_publish_time - previousUnix) > 60) {
    throw new FacebookError("The Facebook schedule differs from GS Poster. Reconcile it before rescheduling.");
  }
  // An uncertain write must be verified rather than repeated.
  let writeError: unknown = null;
  try {
    await post(env, fbPostId, new URLSearchParams({ scheduled_publish_time: String(nextUnix) }));
  } catch (error) {
    writeError = error;
  }
  const after = await getPostInfo(env, fbPostId);
  if (!after || after.is_published !== false ||
      !after.scheduled_publish_time || Math.abs(after.scheduled_publish_time - nextUnix) > 60) {
    throw new FacebookError("Facebook did not confirm the new schedule. Check Meta Business Suite before retrying." +
      (writeError instanceof Error ? " " + writeError.message : ""));
  }
}

/** Edit the caption on a still-scheduled Page post, with read-back confirmation. */
export async function editFbCaption(
  env: Env, fbPostId: string, previousUnix: number, oldCaption: string, nextCaption: string,
): Promise<void> {
  const before = await getPostInfo(env, fbPostId);
  if (!before || before.is_published !== false ||
      !before.scheduled_publish_time || Math.abs(before.scheduled_publish_time - previousUnix) > 60) {
    throw new FacebookError("The Facebook schedule changed or was released. Review it in Meta before editing.");
  }
  if (before.message !== oldCaption) {
    throw new FacebookError("The Facebook caption differs from GS Poster. Reconcile it before editing.");
  }
  let writeError: unknown = null;
  try { await post(env, fbPostId, new URLSearchParams({ message: nextCaption })); }
  catch (error) { writeError = error; }
  const after = await getPostInfo(env, fbPostId);
  if (!after || after.is_published !== false || after.message !== nextCaption) {
    throw new FacebookError("Facebook did not confirm the edited caption. Check Meta before another attempt." +
      (writeError instanceof Error ? " " + writeError.message : ""));
  }
}

export interface PagePost {
  id: string;
  message?: string;
  created_time?: string;
  scheduled_publish_time?: number;
  permalink_url?: string;
  shares?: number;
  reactions?: number;
  comments?: number;
}

export async function listPagePosts(env: Env, kind: "published" | "scheduled", limit: number): Promise<PagePost[]> {
  const { pageId } = need(env);
  const n = String(Math.min(Math.max(limit, 1), 50));
  if (kind === "scheduled") {
    const r = await get(env, `${pageId}/scheduled_posts`, { fields: "id,message,scheduled_publish_time,permalink_url", limit: n });
    return (r.data ?? []) as PagePost[];
  }
  const r = await get(env, `${pageId}/posts`, {
    fields: "id,message,created_time,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)",
    limit: n,
  });
  return (r.data ?? []).map((p: any) => ({
    id: p.id,
    message: p.message,
    created_time: p.created_time,
    permalink_url: p.permalink_url,
    shares: p.shares?.count ?? 0,
    reactions: p.reactions?.summary?.total_count ?? 0,
    comments: p.comments?.summary?.total_count ?? 0,
  }));
}

export async function checkPage(env: Env): Promise<{ id: string; name: string; followers?: number }> {
  const { pageId } = need(env);
  const r = await get(env, pageId, { fields: "id,name,followers_count" });
  return { id: r.id, name: r.name, followers: r.followers_count };
}
