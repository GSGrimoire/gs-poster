/**
 * The only code path that puts anything on Facebook. It is called from the
 * approval page after Gus's GitHub sign-in and PIN check, never from an MCP tool.
 */
import type { Env } from "./env.ts";
import {getTikTokInboxTransfer} from "./tiktok-inbox.ts";
import { audit, claimForPublish, claimDueBluesky, claimFailedBluesky, dueBlueskyIds, getPost, listPosts, setBlueskyStatus, updatePost, updateCalendarTime, updateCalendarCaptions, reopenCancelledDraft, reopenFailedDraft, type Post, type ApprovalSnapshot, tiktokMedia } from "./db.ts";
import { publishBluesky } from "./bluesky.ts";
import { createFeedPost, createPageVideo, getPageVideoInfo, deleteFbPost, getPostInfo, uploadUnpublishedPhoto, rescheduleFbPost, editFbCaption, normalizeCaption } from "./facebook.ts";
import { fetchVideo } from "./video.ts";
import { fetchImage } from "./media.ts";
import { BULK_FACEBOOK_THRESHOLD, enqueueFacebookUpload, ensureFacebookQueue } from "./facebook-queue.ts";

export interface ApproveInput extends ApprovalSnapshot {
  actor: string;
}

/** Called exclusively by an authenticated human approval on the review site. */
export async function approveAndPublish(env: Env, id: string, input: ApproveInput): Promise<Post> {
  const db = env.DB;
  if (!(await claimForPublish(db, id, input))) throw new Error("This post is no longer a draft. It may already have been approved.");
  const post = (await getPost(db, id))!;
  const scheduledUnix = post.scheduled_at ? Math.floor(Date.parse(post.scheduled_at) / 1000) : undefined;

  let fbStatus: "scheduled" | "published" | "failed" | "publishing" = "failed";
  let fbError: string | null = null;
  if (post.facebook_enabled) {
    try {
      if (post.video) {
        if (post.images.length) throw new Error("Facebook cannot publish a video and gallery in one post.");
        const bytes = await fetchVideo(env, post.video);
        // Retain an unknown-response failure as failed for human reconciliation.
        const videoId = await createPageVideo(env, {
          bytes, title: post.label || post.release || "GS Grimoire video",
          description: post.message, scheduledUnix,
        });
        await updatePost(db, id, { fb_post_id: videoId, error: null }, ["publishing"]);
        fbStatus = scheduledUnix ? "scheduled" : "published";
        const permalink = scheduledUnix ? null : (await getPageVideoInfo(env, videoId).catch(() => null))?.permalink_url ?? null;
        await updatePost(db, id, { permalink }, ["publishing"]);
        await audit(db, input.actor, scheduledUnix ? "facebook-video-scheduled" : "facebook-video-published", id, videoId);
      } else if (post.images.length > BULK_FACEBOOK_THRESHOLD) {
        // This claim was recorded by claimForPublish after PIN approval.
        // No remote Facebook request occurs here; cron consumes the durable job.
        await enqueueFacebookUpload(env, id);
        fbStatus = "publishing";
      } else {
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
      }
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

/**
 * PIN-gated, human-reconciled Facebook-only retry. The caller must verify on
 * Facebook that the original attempt created no post before authorizing this.
 * Never touches Bluesky: an already published Bluesky target stays published.
 */
export async function retryFailedFacebook(env: Env, id: string, actor: string): Promise<boolean> {
  const db = env.DB;
  const p = await getPost(db, id);
  if (!p || p.status !== "failed" || !p.facebook_enabled || !p.approved_at || p.fb_post_id) {
    throw new Error("Only approved, unresolved failed Facebook attempts can be retried.");
  }
  // Bulks must never be retried through a one-request publication path.
  if (p.images.length > BULK_FACEBOOK_THRESHOLD) {
    throw new Error("Bulk Facebook posts need queue reconciliation, not the single-post retry path.");
  }
  if (p.scheduled_at && Date.parse(p.scheduled_at) - Date.now() < 12 * 60_000) {
    throw new Error("The scheduled Facebook time is too close or already passed. Do not retry a stale schedule.");
  }
  const claim = await updatePost(db, id, { status: "publishing", error: null }, ["failed"]);
  if (!claim) throw new Error("This Facebook retry was already claimed.");
  const scheduledUnix = p.scheduled_at ? Math.floor(Date.parse(p.scheduled_at) / 1000) : undefined;
  try {
    let fbPostId: string;
    if (p.video) {
      if (p.images.length) throw new Error("A video and image gallery cannot be combined.");
      const bytes = await fetchVideo(env,p.video);
      fbPostId = await createPageVideo(env, {
        bytes, title:p.label || p.release || "GS Grimoire video",
        description:p.message,scheduledUnix,
      });
    } else {
      const mediaIds: string[] = [];
      for (const url of p.images) {
        const img = await fetchImage(env, url);
        mediaIds.push(await uploadUnpublishedPhoto(env, img, scheduledUnix !== undefined));
      }
      fbPostId = await createFeedPost(env, {
        message:p.message,link:p.link,mediaIds,scheduledUnix,
      });
    }
    // Save the returned Facebook identifier before making further calls.
    await updatePost(db, id, { fb_post_id: fbPostId }, ["publishing"]);
    const permalink = scheduledUnix ? null :
      (await getPostInfo(env, fbPostId).catch(() => null))?.permalink_url ?? null;
    await updatePost(db, id, {
      status: scheduledUnix ? "scheduled" : "published", permalink, error: null,
    }, ["publishing"]);
    await audit(db, actor, "facebook-retry-success", id, fbPostId);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A lost Facebook response is ambiguous. Never retry automatically.
    await updatePost(db, id, { status: "failed", error: message }, ["publishing"]);
    await audit(db, actor, "facebook-retry-failed", id, message);
    return false;
  }
}

/** How long an approval may sit in `publishing` before a human may reconcile it. */
export const STUCK_PUBLISHING_MS = 15 * 60_000;

/** A `publishing` post with no Facebook id and no queue job: the approval request
 * ended before recording any result (issue #49). Read-only check used by the page. */
/**
 * `approved_at` is deliberately NOT required. GS Poster v0.1.0 (live until
 * 27 Oct 2026) moved a PIN-approved post to `publishing` first and wrote
 * `approved_at` only after Facebook answered, so a request that died mid-upload
 * left `publishing` with `approved_at = NULL`. Current code sets both in one
 * claim. Such legacy records are recovered the same way and never backfilled.
 */
export async function isStuckPublishing(db: D1Database, p: Post, now = Date.now()): Promise<boolean> {
  if (p.status !== "publishing" || !p.facebook_enabled || p.fb_post_id) return false;
  if (now - Date.parse(p.updated_at) < STUCK_PUBLISHING_MS) return false;
  if (p.bluesky && (["scheduled", "publishing", "published"].includes(p.bluesky.status) ||
      p.bluesky.uri || p.bluesky.cid || p.bluesky.card_uri || p.bluesky.permalink)) return false;
  await ensureFacebookQueue(db);
  const job = await db.prepare("SELECT 1 AS present FROM facebook_upload_jobs WHERE post_id = ?").bind(p.id).first();
  return !job;
}

/**
 * PIN-gated human reconciliation for a stuck approval. The caller has confirmed
 * on Facebook that no post exists. This sends nothing: it only moves the record
 * to `failed`, from where the existing PIN-gated "back to drafts" path applies.
 * One atomic UPDATE fences version, age, missing Facebook id and missing queue job.
 */
export async function reconcileStuckPublishing(
  env: Env, id: string, expectedVersion: string, actor: string, now = Date.now(),
): Promise<boolean> {
  const p = await getPost(env.DB, id);
  if (!p || p.updated_at !== expectedVersion || !(await isStuckPublishing(env.DB, p, now))) return false;
  const cutoff = new Date(now - STUCK_PUBLISHING_MS).toISOString();
  const legacy = !p.approved_at;
  const res = await env.DB.prepare(`UPDATE posts SET status = 'failed', error = ?, updated_at = ?
    WHERE id = ? AND status = 'publishing' AND facebook_enabled = 1
      AND fb_post_id IS NULL AND updated_at = ? AND updated_at <= ?
      AND NOT EXISTS (SELECT 1 FROM facebook_upload_jobs WHERE post_id = ?)
      AND NOT EXISTS (SELECT 1 FROM bluesky_targets b WHERE b.post_id = posts.id AND
        (b.status IN ('scheduled','publishing','published') OR b.uri IS NOT NULL OR b.cid IS NOT NULL
         OR b.card_uri IS NOT NULL OR b.permalink IS NOT NULL))`)
    .bind(
      "The approval request ended before a Facebook result was recorded" +
        (legacy ? " (approved with an older GS Poster version that did not record the approval time)" : "") +
        ". The editor confirmed on Facebook that no post exists. Nothing was resent.",
      new Date(now).toISOString(), id, expectedVersion, cutoff, id,
    ).run();
  if ((res.meta.changes ?? 0) !== 1) return false;
  await audit(env.DB, actor, "stuck-publishing-reconciled", id,
    "confirmed absent on Facebook" + (legacy ? "; legacy record without approved_at" : ""));
  return true;
}

export async function rejectPost(env: Env, id: string, reason: string, actor: string): Promise<boolean> {
  const ok = await updatePost(env.DB, id, { status: "rejected", note: reason || null }, ["draft"]);
  if (ok) await audit(env.DB, actor, "rejected", id, reason || undefined);
  return ok;
}

/**
 * Human PIN-gated calendar move. Drafts remain unapproved. Approved posts are
 * changed in Facebook first, then atomically in D1 (which controls Bluesky cron).
 * No new post is ever created here.
 */
export async function reschedulePost(
  env: Env, id: string, newTime: Date, version: string, actor: string,
): Promise<void> {
  const p = await getPost(env.DB, id);
  if (!p || p.updated_at !== version) throw new Error("Post changed. Reload before rescheduling.");
  const nextIso = newTime.toISOString();
  if ((p.status === "draft" || p.status === "rejected") && !p.approved_at) {
    const saved = await updateCalendarTime(env.DB, id, nextIso, version, false);
    if (!saved) throw new Error("Draft changed before rescheduling. Reload.");
    await audit(env.DB, actor, "draft-rescheduled", id, nextIso);
    return;
  }
  if (p.status !== "scheduled" || !p.approved_at || !p.scheduled_at) {
    throw new Error("Only pending, approved schedules can be moved; published posts are immutable.");
  }
  // Do not race a Facebook publish or a Bluesky cron claim.
  if (Date.parse(p.scheduled_at) - Date.now() < 12 * 60_000) {
    throw new Error("The original schedule is already too close to release to change safely.");
  }
  if (p.bluesky && p.bluesky.status !== "scheduled") {
    throw new Error("One Bluesky target has already started or completed; this combined schedule cannot be moved.");
  }
  if (p.facebook_enabled && !p.fb_post_id) {
    throw new Error("Facebook has no confirmed scheduled post ID; reconcile before changing the schedule.");
  }
  const before = Math.floor(Date.parse(p.scheduled_at) / 1000);
  const after = Math.floor(newTime.getTime() / 1000);
  if (p.facebook_enabled) {
    try { await rescheduleFbPost(env, p.fb_post_id!, before, after, !!p.video); }
    catch {
      // Facebook may have accepted the write before an uncertain read-back.
      await audit(env.DB, actor, "reschedule-reconciliation-required", id,
        p.scheduled_at + " to " + nextIso).catch(() => undefined);
      throw new Error("Facebook's new schedule could not be confirmed. Check Meta Business Suite before retrying.");
    }
  }
  let saved = false;
  let saveError: unknown = null;
  try { saved = await updateCalendarTime(env.DB, id, nextIso, version, true, !!p.bluesky); }
  catch (error) { saveError = error; }
  if (!saved) {
    // Roll back when a concurrent edit wins. If this fails, do not pretend
    // both platforms are aligned: the user must reconcile in Meta.
    if (p.facebook_enabled) {
      try { await rescheduleFbPost(env, p.fb_post_id!, after, before, !!p.video); }
      catch (error) {
        await audit(env.DB, actor, "reschedule-reconciliation-required", id, nextIso);
        throw new Error("Facebook changed, but the GS Poster record did not. Check Meta Business Suite before retrying.");
      }
    }
    throw new Error(saveError ? "GS Poster could not save the schedule; Facebook was restored. Try again later." :
      "Post changed during rescheduling. Reload.");
  }
  await audit(env.DB, actor, "scheduled-rescheduled", id, p.scheduled_at + " to " + nextIso);
}

/** Change unreleased captions through the same human-authenticated, PIN-gated path. */
export async function editPendingCaptions(
  env: Env, id: string, version: string, message: string, blueskyCaption: string | null, actor: string,
  tiktokCaption: string | null = null,
): Promise<void> {
  const p = await getPost(env.DB, id);
  if (!p || p.updated_at !== version) throw new Error("Post changed. Reload before editing.");
  if (message.length > 63_206) throw new Error("Facebook caption is too long.");
  if(p.tiktok_enabled){
    const content=tiktokCaption ?? message;
    const max=tiktokMedia(p).video ? 2200 : 4000;
    if(content.length>max)throw new Error("TikTok caption exceeds its format limit.");
    if(tiktokCaption!==p.tiktok_caption && await getTikTokInboxTransfer(env.DB,id))
      throw new Error("TikTok transfer already started. Its caption cannot be changed here.");
  }
  if (blueskyCaption !== null &&
      [...new Intl.Segmenter("en", {granularity:"grapheme"}).segment(blueskyCaption)].length > 300) {
    throw new Error("Bluesky caption is over 300 characters.");
  }
  if ((p.status === "draft" || p.status === "rejected") && !p.approved_at) {
    const saved = await updateCalendarCaptions(env.DB, p, message, blueskyCaption, false,tiktokCaption);
    if (!saved) throw new Error("The draft changed while saving. Reload.");
    await audit(env.DB, actor, "draft-caption-edited", id);
    return;
  }
  if (p.status !== "scheduled" || !p.approved_at || !p.scheduled_at ||
      Date.parse(p.scheduled_at) - Date.now() < 12*60_000) {
    throw new Error("Only pending schedules with at least 12 minutes remaining can be edited.");
  }
  if (p.bluesky && p.bluesky.status !== "scheduled") {
    throw new Error("Bluesky has already started or completed publishing.");
  }
  if (p.facebook_enabled && !p.fb_post_id) {
    throw new Error("The scheduled Facebook post ID is missing.");
  }
  const facebookCaptionChanged = p.facebook_enabled && normalizeCaption(message) !== normalizeCaption(p.message);
  if (facebookCaptionChanged) {
    try { await editFbCaption(env, p.fb_post_id!, Math.floor(Date.parse(p.scheduled_at)/1000), p.message, message, !!p.video); }
    catch {
      // A successful write followed by a failed read is an uncertain remote state.
      await audit(env.DB, actor, "caption-reconciliation-required", id).catch(() => undefined);
      throw new Error("Facebook's edited caption could not be confirmed. Check Meta Business Suite before retrying.");
    }
  }
  let saved = false;
  let saveError: unknown = null;
  try { saved = await updateCalendarCaptions(env.DB, p, message, blueskyCaption, true,tiktokCaption); }
  catch (error) { saveError = error; }
  if (!saved) {
    if (facebookCaptionChanged) {
      try {
        await editFbCaption(env, p.fb_post_id!, Math.floor(Date.parse(p.scheduled_at)/1000), message, p.message, !!p.video);
      } catch {
        await audit(env.DB, actor, "caption-reconciliation-required", id);
        throw new Error("Facebook changed, but GS Poster did not. Reconcile in Meta Business Suite.");
      }
    }
    throw new Error(saveError ? "GS Poster could not save the captions; Facebook was restored. Try again later." :
      "Post changed while editing. Reload.");
  }
  await audit(env.DB, actor, "scheduled-caption-edited", id);
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

/**
 * Human-PIN gated recovery after both platform schedules were cancelled.
 * Fail closed if Facebook still exposes the previous post or the API cannot
 * confirm its disappearance. The old approval and schedule are always cleared.
 */
export async function restoreCancelledPost(
  env: Env, id: string, expectedVersion: string, actor: string,
): Promise<boolean> {
  const p = await getPost(env.DB,id);
  if (!p || p.status !== "cancelled" || p.updated_at !== expectedVersion) return false;
  if (p.bluesky && (p.bluesky.status !== "cancelled" && p.bluesky.status !== "draft" ||
      p.bluesky.uri || p.bluesky.cid || p.bluesky.card_uri || p.bluesky.permalink)) {
    throw new Error("Bluesky has already started or published this post. Do not restart it as a draft.");
  }
  if (p.facebook_enabled && p.fb_post_id) {
    // A deleted video uses the Video API read, not the Page feed post fields.
    // Permission, timeout and rate-limit errors must not be treated as deletion.
    const remote = p.video
      ? await getPageVideoInfo(env,p.fb_post_id)
      : await getPostInfo(env,p.fb_post_id);
    if (remote) throw new Error(
      "The previous Facebook post still exists. Remove its pending schedule in Meta first; then retry.");
  }
  const restored=await reopenCancelledDraft(env.DB,id,expectedVersion);
  if (restored) await audit(env.DB,actor,"cancelled-reopened-as-draft",id,
    p.fb_post_id ? "previous Facebook object verified absent" : "no recorded Facebook object");
  return restored;
}

/**
 * Failed or rejected -> an ordinary, unapproved draft that the editor can
 * change and that needs a fresh PIN approval. Approved failures may have
 * reached Facebook despite a lost response, so the caller must pass
 * `reconciled` only after the PIN-gated "I checked Facebook" confirmation.
 * All guards and the approval revocation run in one D1 transaction.
 */
export async function backToDraft(
  env: Env, id: string, actor: string, reconciled = false, expectedVersion?: string,
): Promise<boolean> {
  const version = await reopenFailedDraft(env.DB, id, { reconciled, expectedVersion });
  if (version) await audit(env.DB, actor, "back-to-draft", id, reconciled ? "approval revoked after owner check" : undefined);
  return !!version;
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
      const info = p.video ? await getPageVideoInfo(env,p.fb_post_id!) : await getPostInfo(env,p.fb_post_id!);
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
