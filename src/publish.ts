/**
 * The only code path that puts anything on Facebook. It is called from the
 * approval page after Gus's GitHub sign-in and PIN check, never from an MCP tool.
 */
import type { Env } from "./env.ts";
import { audit, claimForPublish, getPost, listPosts, updatePost, type Post } from "./db.ts";
import { createFeedPost, deleteFbPost, getPostInfo, uploadUnpublishedPhoto } from "./facebook.ts";
import { fetchImage } from "./media.ts";

export interface ApproveInput {
  message: string;
  scheduledAt: Date | null;
  actor: string;
}

export async function approveAndPublish(env: Env, id: string, input: ApproveInput): Promise<Post> {
  const db = env.DB;
  // Save Gus's last edits first, while the post is still a draft.
  await updatePost(db, id, { message: input.message, scheduled_at: input.scheduledAt?.toISOString() ?? null }, ["draft"]);
  if (!(await claimForPublish(db, id))) throw new Error("This post is no longer a draft. It may already have been approved.");

  const post = (await getPost(db, id))!;
  try {
    const scheduledUnix = input.scheduledAt ? Math.floor(input.scheduledAt.getTime() / 1000) : undefined;
    const mediaIds: string[] = [];
    for (const url of post.images) {
      const img = await fetchImage(env, url);
      mediaIds.push(await uploadUnpublishedPhoto(env, img, scheduledUnix !== undefined));
    }
    const fbPostId = await createFeedPost(env, { message: post.message, link: post.link, mediaIds, scheduledUnix });
    let permalink: string | null = null;
    if (!scheduledUnix) permalink = (await getPostInfo(env, fbPostId).catch(() => null))?.permalink_url ?? null;
    await updatePost(db, id, {
      status: scheduledUnix ? "scheduled" : "published",
      fb_post_id: fbPostId,
      permalink,
      approved_at: new Date().toISOString(),
      error: null,
    });
    await audit(db, input.actor, scheduledUnix ? "approved-scheduled" : "approved-published", id, fbPostId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updatePost(db, id, { status: "failed", error: msg });
    await audit(db, input.actor, "publish-failed", id, msg);
  }
  return (await getPost(db, id))!;
}

/** Gus's edits to a draft, kept without approving it. Nothing goes to Facebook. */
export async function saveEdits(env: Env, id: string, input: ApproveInput): Promise<boolean> {
  const ok = await updatePost(env.DB, id, { message: input.message, scheduled_at: input.scheduledAt?.toISOString() ?? null }, ["draft"]);
  if (ok) await audit(env.DB, input.actor, "edited", id);
  return ok;
}

export async function rejectPost(env: Env, id: string, reason: string, actor: string): Promise<boolean> {
  const ok = await updatePost(env.DB, id, { status: "rejected", note: reason || null }, ["draft"]);
  if (ok) await audit(env.DB, actor, "rejected", id, reason || undefined);
  return ok;
}

/** Take a scheduled post off Facebook's schedule. */
export async function cancelScheduled(env: Env, id: string, actor: string): Promise<void> {
  const post = await getPost(env.DB, id);
  if (!post || post.status !== "scheduled" || !post.fb_post_id) throw new Error("Only scheduled posts can be cancelled here.");
  await deleteFbPost(env, post.fb_post_id);
  await updatePost(env.DB, id, { status: "cancelled" }, ["scheduled"]);
  await audit(env.DB, actor, "cancelled", id, post.fb_post_id);
}

/** Failed or rejected → draft again, so it can be fixed and re-approved. */
export async function backToDraft(env: Env, id: string, actor: string): Promise<boolean> {
  const ok = await updatePost(env.DB, id, { status: "draft", error: null }, ["failed", "rejected"]);
  if (ok) await audit(env.DB, actor, "back-to-draft", id);
  return ok;
}

/**
 * Scheduled posts whose time has passed: ask Facebook whether they went out.
 * Called lazily from list views; Facebook does the actual publishing.
 */
export async function refreshScheduled(env: Env): Promise<void> {
  if (!env.FB_PAGE_TOKEN) return;
  const due = (await listPosts(env.DB, { status: "scheduled", limit: 20 })).filter(
    (p) => p.scheduled_at && Date.parse(p.scheduled_at) < Date.now() && p.fb_post_id,
  );
  for (const p of due.slice(0, 10)) {
    try {
      const info = await getPostInfo(env, p.fb_post_id!);
      if (!info) {
        await updatePost(env.DB, p.id, { status: "cancelled", note: "Removed on Facebook" }, ["scheduled"]);
      } else if (info.is_published) {
        await updatePost(env.DB, p.id, { status: "published", permalink: info.permalink_url ?? null }, ["scheduled"]);
      }
    } catch {
      // Leave it; next view retries.
    }
  }
}
