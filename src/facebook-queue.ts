/**
 * A durable, PIN-approved Facebook bulk photo queue.
 * One cron invocation handles at most eight photo downloads/uploads
 * (16 external subrequests), then checkpoints each returned media id in D1.
 *
 * Feed creation has a one-way "sending" barrier. If the Graph response is
 * ambiguous, the job remains blocked instead of risking a duplicate post.
 */
import type { Env } from "./env.ts";
import { audit, getPost, updatePost } from "./db.ts";
import { createFeedPost, getPostInfo, uploadUnpublishedPhoto } from "./facebook.ts";
import { fetchImage } from "./media.ts";
import { FACEBOOK_IMAGE_BATCH_SIZE } from "./validate.ts";

export const BULK_FACEBOOK_THRESHOLD = 10;
export const BULK_SCHEDULE_MIN_LEAD_MS = 30 * 60 * 1000;

interface Job {
  post_id: string;
  media_ids: string;
  next_index: number;
  status: "uploading" | "busy" | "sending" | "failed" | "done" | "cancelled";
  started_at: string | null;
  error: string | null;
}

let tableReady = false;
export async function ensureFacebookQueue(db: D1Database): Promise<void> {
  if (tableReady) return;
  await db.prepare(\`CREATE TABLE IF NOT EXISTS facebook_upload_jobs (
    post_id TEXT PRIMARY KEY,
    media_ids TEXT NOT NULL DEFAULT '[]',
    next_index INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'uploading',
    started_at TEXT,
    error TEXT
  )\`).run();
  tableReady = true;
}

export interface FacebookUploadProgress {
  uploaded: number;
  total: number;
  status: Job["status"];
  error: string | null;
}

export async function getFacebookUploadProgress(db: D1Database, postId: string, total: number): Promise<FacebookUploadProgress | null> {
  await ensureFacebookQueue(db);
  const job = await db.prepare("SELECT * FROM facebook_upload_jobs WHERE post_id = ?").bind(postId).first<Job>();
  return job ? { uploaded: job.next_index, total, status: job.status, error: job.error } : null;
}

/** Called only after claimForPublish and the human PIN gate. */
export async function enqueueFacebookUpload(env: Env, postId: string): Promise<void> {
  await ensureFacebookQueue(env.DB);
  const res = await env.DB.prepare(\`INSERT INTO facebook_upload_jobs (post_id)
    SELECT id FROM posts WHERE id = ? AND status = 'publishing' AND approved_at IS NOT NULL
    ON CONFLICT(post_id) DO NOTHING\`).bind(postId).run();
  if ((res.meta.changes ?? 0) !== 1) throw new Error("Could not enqueue the approved Facebook upload.");
}

async function claimedJob(db: D1Database, now: string): Promise<Job | null> {
  await ensureFacebookQueue(db);
  const stale = new Date(Date.parse(now) - 15 * 60_000).toISOString();
  const row = await db.prepare(\`SELECT f.* FROM facebook_upload_jobs f
    JOIN posts p ON p.id = f.post_id
    WHERE p.status = 'publishing' AND p.approved_at IS NOT NULL
      AND (f.status = 'uploading' OR (f.status = 'busy' AND f.started_at < ?))
    ORDER BY p.approved_at LIMIT 1\`).bind(stale).first<Job>();
  if (!row) return null;
  const claim = await db.prepare(\`UPDATE facebook_upload_jobs SET status = 'busy', started_at = ?, error = NULL
    WHERE post_id = ? AND (status = 'uploading' OR (status = 'busy' AND started_at < ?))
      AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND status = 'publishing' AND approved_at IS NOT NULL)\`)
    .bind(now, row.post_id, stale, row.post_id).run();
  return (claim.meta.changes ?? 0) === 1 ? { ...row, status: "busy", started_at: now } : null;
}

/**
 * Cron consumes at most one batch per run so Facebook + Bluesky can coexist
 * within the free plan's 50 outgoing-request allowance.
 */
export async function processFacebookUploadBatch(env: Env): Promise<void> {
  const job = await claimedJob(env.DB, new Date().toISOString());
  if (!job) return;
  const post = await getPost(env.DB, job.post_id);
  if (!post || !post.facebook_enabled || !post.approved_at || post.fb_post_id) return;
  const end = Math.min(job.next_index + FACEBOOK_IMAGE_BATCH_SIZE, post.images.length);
  const scheduledUnix = post.scheduled_at ? Math.floor(Date.parse(post.scheduled_at) / 1000) : undefined;
  try {
    let index = job.next_index;
    for (; index < end; index++) {
      const image = await fetchImage(env, post.images[index]);
      const mediaId = await uploadUnpublishedPhoto(env, image, scheduledUnix !== undefined);
      // The checkpoint is persisted after each successful upload, not just after
      // each group of eight. A crash cannot cause an attached-media index gap.
      const saved = await env.DB.prepare(\`UPDATE facebook_upload_jobs
        SET next_index = next_index + 1, media_ids = json_insert(media_ids, '$[#]', ?)
        WHERE post_id = ? AND status = 'busy' AND next_index = ?\`)
        .bind(mediaId, post.id, index).run();
      if ((saved.meta.changes ?? 0) !== 1) throw new Error("Upload checkpoint was lost; no Facebook feed post was sent.");
    }
    if (index < post.images.length) {
      await env.DB.prepare("UPDATE facebook_upload_jobs SET status = 'uploading' WHERE post_id = ? AND status = 'busy'").bind(post.id).run();
      await audit(env.DB, "cron", "facebook-batch", post.id, index + "/" + post.images.length);
      return;
    }
    // The send barrier is deliberately not automatically retried: a lost Meta
    // response may mean the feed post was already created.
    const send = await env.DB.prepare("UPDATE facebook_upload_jobs SET status = 'sending' WHERE post_id = ? AND status = 'busy'")
      .bind(post.id).run();
    if ((send.meta.changes ?? 0) !== 1) throw new Error("Could not lock the final Facebook publication.");
    const all = await env.DB.prepare("SELECT media_ids FROM facebook_upload_jobs WHERE post_id = ?")
      .bind(post.id).first<{ media_ids: string }>();
    const ids = JSON.parse(all?.media_ids ?? "[]") as string[];
    if (ids.length !== post.images.length) throw new Error("Facebook image count changed during finalization.");
    const fbPostId = await createFeedPost(env, {
      message: post.message, link: post.link, mediaIds: ids, scheduledUnix,
    });
    // Save the remote id BEFORE status. A crash after this point can be safely
    // recovered by a human without reissuing the Graph post request.
    await updatePost(env.DB, post.id, { fb_post_id: fbPostId }, ["publishing"]);
    const permalink = scheduledUnix ? null :
      (await getPostInfo(env, fbPostId).catch(() => null))?.permalink_url ?? null;
    await updatePost(env.DB, post.id, {
      status: scheduledUnix ? "scheduled" : "published", permalink, error: null,
    }, ["publishing"]);
    await env.DB.prepare("UPDATE facebook_upload_jobs SET status = 'done', error = NULL WHERE post_id = ? AND status = 'sending'")
      .bind(post.id).run();
    await audit(env.DB, "cron", scheduledUnix ? "facebook-bulk-scheduled" : "facebook-bulk-published", post.id, fbPostId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A final send may already have succeeded. Block the job for reconciliation,
    // rather than attempt an automatic second feed request.
    await env.DB.prepare(\`UPDATE facebook_upload_jobs SET status = 'failed', error = ?
      WHERE post_id = ? AND status IN ('busy','sending')\`).bind(message, post.id).run();
    await audit(env.DB, "cron", "facebook-bulk-failed", post.id, message);
  }
}

/** After human sign-in and PIN, retry only uploads, never an ambiguous feed send. */
export async function resumeFailedFacebookUploads(env: Env, id: string, actor: string): Promise<boolean> {
  await ensureFacebookQueue(env.DB);
  const post = await getPost(env.DB, id);
  if (!post || post.status !== "publishing" || !post.approved_at || post.fb_post_id) return false;
  const job = await env.DB.prepare("SELECT * FROM facebook_upload_jobs WHERE post_id = ?").bind(id).first<Job>();
  if (!job || job.status !== "failed" || job.next_index >= post.images.length) return false;
  const res = await env.DB.prepare(\`UPDATE facebook_upload_jobs SET status = 'uploading', error = NULL
    WHERE post_id = ? AND status = 'failed' AND next_index < ?\`).bind(id, post.images.length).run();
  if ((res.meta.changes ?? 0) === 1) await audit(env.DB, actor, "facebook-bulk-resume", id);
  return (res.meta.changes ?? 0) === 1;
}
