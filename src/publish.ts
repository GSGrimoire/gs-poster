/**
 * The only code path that puts anything on Facebook. It is called from the
 * approval page after Gus's GitHub sign-in and PIN check, never from an MCP tool.
 */
import type { Env } from "./env.ts";
import { audit, claimForPublish, claimDueBluesky, claimFailedBluesky, dueBlueskyIds, getPost, listPosts, setBlueskyStatus, updatePost, type Post, type ApprovalSnapshot } from "./db.ts";
import { publishBluesky } from "./bluesky.ts";
import { createFeedPost, deleteFbPost, getPostInfo, uploadUnpublishedPhoto } from "./facebook.ts";
import { fetchImage } from "./media.ts";

export interface ApproveInput extends ApprovalSnapshot {
  actor: string;
}

/** Called exclusively by an authenticated human approval on the review site. */
export async function approveAndPublish(env: Env, id: string, input: ApproveInput): Promise<Post> {
  const db = env.DB;
  if (!(await claimForPublish(db, id, input))) throw new Error("This post is no longer a draft. It may already have been approved.");
  const post = (await getPost(db, id))!;
  const scheduledUnix = post.scheduled_at ? Math.floor(Date.parse(post.scheduled_at) / 1000) : undefined;

  let fbStatus: "scheduled" | "published" | "failed" = "failed";
  let fbError: string | null = null;
  if (post.facebook_enabled) {
    try {
      const mediaIds: string[] = [];
      for (const url of post.images) {
        const img = await fetchImage(env, url);
        mediaIds.push(await uploadUnpublishedPhoto(env, img, scheduledUnix !== undefined));
      }
      const fbPostId = await createFeedPost(env, { message: post.message, link: post.link, mediaIds, scheduledUnix });
      const permalink = scheduledUnix ? null : (await getPostInfo(env, fbPostId).catch(() => null))?.permalink_url ?? null;
      fbStatus = scheduledUnix ? "scheduled" : "published";
      await updatePost(db, id, { fb_post_id: fbPostId, permalink, error: null }, ["publishing"]);
      await audit(db, input.actor, scheduledUnix ? "facebook-scheduled" : "facebook-published", id, fbPostId);
    } catch (e) {
      fbError = e instanceof Error ? e.message : String(e);
      await audit(db, input.actor, "facebook-failed", id, fbError);
    }
  }

  let bsStatus: "scheduled" | "published" | "failed" = "failed";
  let bsError: string | null = null;
  if (post.bluesky) {
    if (scheduledUnix !== undefined) {
      await setBlueskyStatus(db, id, { status: "scheduled" }, ["draft"]);
      bsStatus = "scheduled";
    } else {
      const success = await finishBluesky(env, id, input.actor);
      bsStatus = success ? "published" : "failed";
      bsError = success ? null : (await getPost(db, id))?.bluesky?.error ?? "Unknown Bluesky error";
    }
  }

  const finalStatus = post.facebook_enabled ? fbStatus : bsStatus;
  await updatePost(db, id, {
    status: finalStatus,
    error: post.facebook_enabled ? fbError : bsError,
  }, ["publishing"]);
  await audit(db, input.actor, "approved-" + finalStatus, id,
    [post.facebook_enabled ? "facebook:" + fbStatus : null, post.bluesky ? "bluesky:" + bsStatus : null].filter(Boolean).join(","));
  return (await getPost(db, id))!;
}

/** Never invoked from an MCP tool. Caller already claimed the approved target. */
async function finishBluesky(env: Env, id: string, actor: string): Promise<boolean> {
  const post = await getPost(env.DB, id);
  if (!post?.bluesky) return false;
  try {
    const result = await publishBluesky(env, id, post.bluesky);
    await setBlueskyStatus(env.DB, id, {
      status: "published", uri: result.uri, cid: result.cid,
      card_uri: result.cardUri, permalink: result.permalink, error: null,
    }, ["draft", "publishing"]);
    await audit(env.DB, actor, "bluesky-published", id, result.uri);
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setBlueskyStatus(env.DB, id, { status: "failed", error: message }, ["draft", "publishing"]);
    await audit(env.DB, actor, "bluesky-failed", id, message);
    return false;
  }
}

/** Cron: take a due approved target atomically, then post. No approval bypass. */
export async function publishDueBluesky(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const ids = await dueBlueskyIds(env.DB, now);
  for (const id of ids.slice(0, 10)) {
    if (!(await claimDueBluesky(env.DB, id, now))) continue;
    const ok = await finishBluesky(env, id, "cron");
    const p = await getPost(env.DB, id);
    if (p && !p.facebook_enabled) {
      await updatePost(env.DB, id, {
        status: ok ? "published" : "failed",
        error: ok ? null : p.bluesky?.error ?? "Bluesky failed",
      }, ["scheduled"]);
    }
  }
}

/** Human-controlled retry after a PIN, never repeats the Facebook target. */
export async function retryFailedBluesky(env: Env, id: string, actor: string): Promise<boolean> {
  if (!(await claimFailedBluesky(env.DB, id))) throw new Error("Only previously approved, failed Bluesky targets can be retried.");
  const ok = await finishBluesky(env, id, actor);
  const p = await getPost(env.DB, id);
  if (p && !p.facebook_enabled) {
    await updatePost(env.DB, id, { status: ok ? "published" : "failed", error: ok ? null : p.bluesky?.error ?? "Bluesky failed" },
      ["failed"]);
  }
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
  if (!post) throw new Error("Post not found.");
  const fbScheduled = post.status === "scheduled" && post.facebook_enabled && !!post.fb_post_id;
  const bsScheduled = post.bluesky?.status === "scheduled";
  if (!fbScheduled && !bsScheduled) throw new Error("No scheduled target remains to cancel.");

  // Stop the Worker queue first, before any potentially slow Facebook API call.
  let stoppedBluesky = false;
  if (bsScheduled) {
    stoppedBluesky = await setBlueskyStatus(env.DB, id, { status: "cancelled" }, ["scheduled"]);
    if (!stoppedBluesky) throw new Error("Bluesky has started publishing; it could not be cancelled.");
  }
  try {
    if (fbScheduled) await deleteFbPost(env, post.fb_post_id!);
  } catch (e) {
    if (stoppedBluesky) await setBlueskyStatus(env.DB, id, { status: "scheduled" }, ["cancelled"]);
    throw e;
  }
  // A successful Facebook post or failed Facebook attempt keeps its own status
  // when only the pending Bluesky target was cancelled.
  if (fbScheduled || (post.status === "scheduled" && !post.facebook_enabled)) {
    await updatePost(env.DB, id, { status: "cancelled" }, ["scheduled"]);
  }
  await audit(env.DB, actor, "cancelled-targets", id,
    [fbScheduled ? "facebook" : null, stoppedBluesky ? "bluesky" : null].filter(Boolean).join(","));
}

/** Failed or rejected → draft again, so it can be fixed and re-approved. */
export async function backToDraft(env: Env, id: string, actor: string): Promise<boolean> {
  const p = await getPost(env.DB, id);
  // Never reapprove Facebook when Bluesky may already have been scheduled/published.
  if (p?.bluesky && ["scheduled", "publishing", "published"].includes(p.bluesky.status)) return false;
  const ok = await updatePost(env.DB, id, { status: "draft", error: null }, ["failed", "rejected"]);
  if (ok && p?.bluesky?.status === "failed") {
    await setBlueskyStatus(env.DB, id, { status: "draft", error: null }, ["failed"]);
  }
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
        if (p.bluesky?.status === "scheduled") await setBlueskyStatus(env.DB, p.id, { status: "cancelled" }, ["scheduled"]);
        await updatePost(env.DB, p.id, { status: "cancelled", note: "Removed on Facebook" }, ["scheduled"]);
      } else if (info.is_published) {
        await updatePost(env.DB, p.id, { status: "published", permalink: info.permalink_url ?? null }, ["scheduled"]);
      }
    } catch {
      // Leave it; next view retries.
    }
  }
}
