/**
 * Approved Instagram publishing through the Instagram account linked to the
 * Facebook Page (Graph API, Page token, IG_USER_ID).
 *
 * Safety model, mirroring the Facebook photo queue:
 * - Only a signed-in, PIN-gated approval creates a job (queueInstagramOnApproval).
 *   The job freezes the exact approved caption, frame, photos or Reel video, so
 *   later draft edits never change what goes out.
 * - Nothing is sent inside the approval request. Cron claims one due job at a
 *   time with a lease; every write is fenced by that lease.
 * - Media containers are safe to recreate (unpublished containers expire), so
 *   failures before the final call can be retried by a human with the PIN.
 * - The final media_publish call sits behind a one-way `sending` barrier. A lost
 *   or unclear answer leaves the job failed and marked ambiguous: it is never
 *   resent automatically, and a human retry needs an explicit "I checked
 *   Instagram" confirmation as well as the PIN.
 * - Meta fetches each JPEG or MP4 from a short-lived, unguessable, individually
 *   hashed link that works only while its job is being prepared or sent. The
 *   private R2 objects and GitHub sources are never exposed.
 * No Model Context Protocol tool calls anything in this file.
 */
import type { Env } from "./env.ts";
import { audit, ensureSchema, getPost, INSTAGRAM_JOBS_DDL } from "./db.ts";
import { graphGet, graphPost } from "./facebook.ts";
import { fetchImage } from "./media.ts";
import { fetchVideo } from "./video.ts";
import { randomToken, sha256 } from "./session.ts";
import { esc } from "./html.ts";
import { checkMessage } from "./validate.ts";
import {
  INSTAGRAM_CAPTION_MAX, INSTAGRAM_FRAMES, INSTAGRAM_MAX_ITEMS, countHashtags, countMentions,
  INSTAGRAM_HASHTAG_MAX, INSTAGRAM_MENTION_MAX, renderInstagram,
  type InstagramFrame, type InstagramItem,
} from "./instagram.ts";

export const INSTAGRAM_MEDIA_PATH = "/instagram/media/";
/** Long enough for Reel processing plus a few delayed cron runs. */
export const INSTAGRAM_LEASE_SECONDS = 6 * 3600;
/** A claimed job is released after this, so a crashed run cannot block the queue. */
export const INSTAGRAM_CLAIM_MS = 3 * 60_000;
/** Carousel photo containers per cron run. With the parent and status call this
 * keeps Instagram to at most six outside requests per minute, leaving room for
 * the Facebook queue and Bluesky inside the 50-request free-plan allowance. */
export const INSTAGRAM_CHILDREN_PER_RUN = 5;
/** How long the final send may run before its result is treated as unclear. */
export const INSTAGRAM_SEND_LEASE_MS = 10 * 60_000;
/** Give up waiting for Meta to process a container after this long. */
export const INSTAGRAM_PROCESSING_LIMIT_MS = 2 * 3600_000;

export type InstagramJobStatus =
  | "scheduled" | "preparing" | "processing" | "sending" | "published" | "failed" | "cancelled";
export type InstagramKind = "IMAGE" | "CAROUSEL" | "REELS";

export interface InstagramJob {
  post_id: string;
  status: InstagramJobStatus;
  kind: InstagramKind;
  due_at: string;
  caption: string;
  frame: InstagramFrame;
  items: InstagramItem[];
  video: string | null;
  children: string[];
  container_id: string | null;
  processing_since: string | null;
  media_id: string | null;
  permalink: string | null;
  error: string | null;
  ambiguous: boolean;
  lease_until: string | null;
  created_by: string;
  updated_at: string;
}

interface Row extends Omit<InstagramJob, "items" | "children" | "ambiguous"> {
  items: string;
  children: string;
  ambiguous: number;
}

const fromRow = (r: Row): InstagramJob => ({
  ...r, items: JSON.parse(r.items || "[]"), children: JSON.parse(r.children || "[]"), ambiguous: r.ambiguous === 1,
});

/** Automatic Instagram posting needs both the Page token and the linked account id. */
export function instagramConfigured(env: Env): boolean {
  return !!(env.FB_PAGE_TOKEN && env.IG_USER_ID && /^[0-9]{5,30}$/.test(env.IG_USER_ID));
}

let schemaReady = false;
export async function ensureInstagramJobs(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await ensureSchema(db);
  await db.batch([
    db.prepare(INSTAGRAM_JOBS_DDL),
    db.prepare("CREATE INDEX IF NOT EXISTS instagram_jobs_due ON instagram_jobs(status, due_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS instagram_media_grants (
      token_hash TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      item_index INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS instagram_media_grants_post ON instagram_media_grants(post_id)"),
  ]);
  schemaReady = true;
}

export async function getInstagramJob(db: D1Database, postId: string): Promise<InstagramJob | null> {
  await ensureInstagramJobs(db);
  const row = await db.prepare("SELECT * FROM instagram_jobs WHERE post_id = ?").bind(postId).first<Row>();
  return row ? fromRow(row) : null;
}

/** What one approval would publish, or why it cannot. Read-only. */
export type InstagramPlan =
  | { ok: true; kind: InstagramKind; count: number; caption: string }
  | { ok: false; offered: boolean; reason: string };

export function instagramReleasePlan(env: Env, post: {
  instagram: { caption: string; frame: InstagramFrame; items: InstagramItem[]; video?: string | null } | null;
}, job: InstagramJob | null): InstagramPlan {
  const ig = post.instagram;
  if (!ig) return { ok: false, offered: false, reason: "Instagram is not selected for this post." };
  if (!instagramConfigured(env)) return { ok: false, offered: false,
    reason: "Instagram is not connected yet (IG_USER_ID is not set), so it stays a manual download." };
  if (job && job.status !== "cancelled") return { ok: false, offered: true, reason: job.status === "published"
    ? "This post is already on Instagram. Make a new draft to post it again."
    : "Instagram already has an approved job for this post. Cancel it in the Instagram card first." };
  const problems: string[] = [];
  if (ig.video && ig.items.length) problems.push("choose either photos or a Reel video, not both");
  if (!ig.video && !ig.items.length) problems.push("add photos or a Reel video in the Instagram card");
  if (ig.items.length > INSTAGRAM_MAX_ITEMS) problems.push(`at most ${INSTAGRAM_MAX_ITEMS} photos`);
  if (!INSTAGRAM_FRAMES.includes(ig.frame)) problems.push("choose a frame");
  if (ig.caption.length > INSTAGRAM_CAPTION_MAX) problems.push(`the caption is over ${INSTAGRAM_CAPTION_MAX} characters`);
  if (countHashtags(ig.caption) > INSTAGRAM_HASHTAG_MAX) problems.push(`at most ${INSTAGRAM_HASHTAG_MAX} hashtags`);
  if (countMentions(ig.caption) > INSTAGRAM_MENTION_MAX) problems.push(`at most ${INSTAGRAM_MENTION_MAX} @ tags`);
  // The same house rules every other caption must pass.
  problems.push(...checkMessage(ig.caption, { hasImages: true }).errors.map((e) => e.replace(/\.$/, "")));
  if (problems.length) return { ok: false, offered: true, reason: "Fix in the Instagram card and save first: " + problems.join("; ") + "." };
  const kind: InstagramKind = ig.video ? "REELS" : ig.items.length > 1 ? "CAROUSEL" : "IMAGE";
  return { ok: true, kind, count: ig.video ? 1 : ig.items.length, caption: ig.caption };
}

/**
 * Called only from the PIN-gated approval, fenced on the version the owner
 * reviewed. Freezes the Instagram content. A cancelled job may be replaced; any
 * other existing job (active, failed or published) blocks a second approval.
 */
export async function queueInstagramOnApproval(
  env: Env, postId: string, expectedVersion: string, dueAt: Date, actor: string,
): Promise<InstagramJob> {
  const post = await getPost(env.DB, postId);
  if (!post || post.updated_at !== expectedVersion) throw new Error("The draft changed. Reload before approving.");
  await ensureInstagramJobs(env.DB);
  const plan = instagramReleasePlan(env, post, await getInstagramJob(env.DB, postId));
  if (!plan.ok) throw new Error(plan.reason);
  const ig = post.instagram!;
  const now = new Date().toISOString();
  const res = await env.DB.prepare(`INSERT INTO instagram_jobs
      (post_id, status, kind, due_at, caption, frame, items, video, created_by, updated_at)
    SELECT ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ? FROM posts
      WHERE id = ? AND updated_at = ? AND status = 'draft' AND approved_at IS NULL
        AND EXISTS (SELECT 1 FROM instagram_targets i WHERE i.post_id = posts.id AND i.status = 'draft')
    ON CONFLICT(post_id) DO UPDATE SET status = 'scheduled', kind = excluded.kind, due_at = excluded.due_at,
      caption = excluded.caption, frame = excluded.frame, items = excluded.items, video = excluded.video,
      children = '[]', container_id = NULL, processing_since = NULL, media_id = NULL, permalink = NULL,
      error = NULL, ambiguous = 0, lease_until = NULL, created_by = excluded.created_by,
      updated_at = excluded.updated_at
    WHERE instagram_jobs.status = 'cancelled'`)
    .bind(postId, plan.kind, dueAt.toISOString(), ig.caption, ig.frame,
      JSON.stringify(ig.video ? [] : ig.items), ig.video ?? null, actor, now, postId, expectedVersion).run();
  if ((res.meta.changes ?? 0) !== 1) throw new Error("Instagram could not be queued: the draft changed or a job already exists. Reload.");
  await audit(env.DB, actor, "instagram-queued", postId, plan.kind + " at " + dueAt.toISOString());
  return (await getInstagramJob(env.DB, postId))!;
}

/** PIN-gated: stop a job that has not reached the final send. Sends nothing. */
export async function cancelInstagramJob(env: Env, postId: string, actor: string): Promise<boolean> {
  await ensureInstagramJobs(env.DB);
  const now = new Date().toISOString();
  const res = await env.DB.prepare(`UPDATE instagram_jobs SET status = 'cancelled', lease_until = NULL, updated_at = ?
    WHERE post_id = ? AND (status = 'scheduled' OR (status = 'failed' AND ambiguous = 0)
      OR (status IN ('preparing','processing') AND (lease_until IS NULL OR lease_until < ?)))`)
    .bind(now, postId, now).run();
  if ((res.meta.changes ?? 0) !== 1) return false;
  await env.DB.prepare("DELETE FROM instagram_media_grants WHERE post_id = ?").bind(postId).run();
  await audit(env.DB, actor, "instagram-cancelled", postId);
  return true;
}

/**
 * PIN-gated, after an ambiguous final send the owner checked Instagram and found
 * nothing. Stops the job without sending. The draft can then be approved again.
 */
export async function closeAmbiguousInstagramJob(env: Env, postId: string, actor: string): Promise<boolean> {
  await ensureInstagramJobs(env.DB);
  const res = await env.DB.prepare(`UPDATE instagram_jobs SET status = 'cancelled', lease_until = NULL, updated_at = ?
    WHERE post_id = ? AND status = 'failed' AND ambiguous = 1`).bind(new Date().toISOString(), postId).run();
  if ((res.meta.changes ?? 0) !== 1) return false;
  await env.DB.prepare("DELETE FROM instagram_media_grants WHERE post_id = ?").bind(postId).run();
  await audit(env.DB, actor, "instagram-ambiguous-closed", postId, "owner checked Instagram: not posted");
  return true;
}

/** PIN-gated retry of a failure that happened before the final send. */
export async function retryInstagramJob(env: Env, postId: string, actor: string): Promise<boolean> {
  await ensureInstagramJobs(env.DB);
  const now = new Date().toISOString();
  const res = await env.DB.prepare(`UPDATE instagram_jobs SET status = 'scheduled', due_at = ?, children = '[]',
      container_id = NULL, processing_since = NULL, error = NULL, lease_until = NULL, updated_at = ?
    WHERE post_id = ? AND status = 'failed' AND ambiguous = 0 AND media_id IS NULL`)
    .bind(now, now, postId).run();
  if ((res.meta.changes ?? 0) !== 1) return false;
  await env.DB.prepare("DELETE FROM instagram_media_grants WHERE post_id = ?").bind(postId).run();
  await audit(env.DB, actor, "instagram-retry", postId);
  return true;
}

/** Stop a pending (not yet started) Instagram job alongside its post's cancellation. */
export async function cancelScheduledInstagram(db: D1Database, postId: string): Promise<boolean> {
  await ensureInstagramJobs(db);
  const res = await db.prepare("UPDATE instagram_jobs SET status = 'cancelled', updated_at = ? WHERE post_id = ? AND status = 'scheduled'")
    .bind(new Date().toISOString(), postId).run();
  return (res.meta.changes ?? 0) === 1;
}

// ---------------------------------------------------------------- media links

function publicBase(env: Env, origin?: string): string {
  return (env.PUBLIC_ORIGIN || origin || "https://gs-poster.goofyspook.workers.dev").replace(/\/$/, "");
}

async function createGrant(env: Env, postId: string, kind: "photo" | "video", index: number): Promise<string> {
  const token = randomToken();
  await env.DB.prepare(`INSERT INTO instagram_media_grants (token_hash, post_id, kind, item_index, expires_at)
    VALUES (?, ?, ?, ?, ?)`).bind(await sha256(token), postId, kind, index,
    Math.floor(Date.now() / 1000) + INSTAGRAM_LEASE_SECONDS).run();
  return publicBase(env) + INSTAGRAM_MEDIA_PATH + token + (kind === "video" ? ".mp4" : ".jpg");
}

/** Public, unauthenticated: serves one frozen, approved item to Meta's fetcher. */
export async function serveInstagramMedia(req: Request, env: Env): Promise<Response> {
  const headers = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" };
  if (req.method !== "GET" && req.method !== "HEAD")
    return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
  const m = /^\/instagram\/media\/([A-Za-z0-9_-]{32,90})\.(jpg|mp4)$/.exec(new URL(req.url).pathname);
  const notFound = () => new Response("Not found", { status: 404, headers });
  if (!m) return notFound();
  await ensureInstagramJobs(env.DB);
  const grant = await env.DB.prepare(`SELECT g.kind AS kind, g.item_index AS item_index, g.post_id AS post_id
    FROM instagram_media_grants g JOIN instagram_jobs j ON j.post_id = g.post_id
    WHERE g.token_hash = ? AND g.expires_at > ? AND j.status IN ('preparing','processing','sending')`)
    .bind(await sha256(m[1]), Math.floor(Date.now() / 1000))
    .first<{ kind: string; item_index: number; post_id: string }>();
  if (!grant || (grant.kind === "video") !== (m[2] === "mp4")) return notFound();
  const job = await getInstagramJob(env.DB, grant.post_id);
  if (!job) return notFound();
  const type = grant.kind === "video" ? "video/mp4" : "image/jpeg";
  if (req.method === "HEAD") return new Response(null, { headers: { ...headers, "Content-Type": type } });
  try {
    if (grant.kind === "video") {
      if (!job.video) return notFound();
      const bytes = await fetchVideo(env, job.video);
      return new Response(bytes, { headers: { ...headers, "Content-Type": type, "Content-Length": String(bytes.byteLength) } });
    }
    const item = job.items[grant.item_index];
    if (!item) return notFound();
    if (!env.IMAGES) throw new Error("Image renderer unavailable");
    const img = await fetchImage(env, item.url);
    const jpeg = await renderInstagram(env.IMAGES, new Uint8Array(img.bytes), job.frame, item);
    return new Response(jpeg, { headers: { ...headers, "Content-Type": type, "Content-Length": String(jpeg.byteLength) } });
  } catch {
    return new Response("Media unavailable", { status: 502, headers });
  }
}

// ---------------------------------------------------------------- cron

async function claimDue(db: D1Database, now: Date): Promise<InstagramJob | null> {
  await ensureInstagramJobs(db);
  const iso = now.toISOString();
  // A final send that outlived its lease (Worker stopped, database failed)
  // becomes an unclear result for the owner. It is never sent again.
  await db.prepare(`UPDATE instagram_jobs SET status = 'failed', ambiguous = 1, lease_until = NULL, updated_at = ?,
      error = 'The final Instagram publish request was interrupted before GS Poster recorded its answer. It may or may not be on Instagram. Check the GS Grimoire Instagram; nothing will be resent automatically.'
    WHERE status = 'sending' AND (lease_until IS NULL OR lease_until < ?)`).bind(iso, iso).run();
  // Legacy safety net: a post deleted before deletion was guarded takes its unsent job with it. A job already past
  // the sending barrier is left alone: it may exist on Instagram.
  await db.prepare(`UPDATE instagram_jobs SET status = 'cancelled', lease_until = NULL, updated_at = ?,
      error = 'The post was deleted before it reached Instagram. Nothing was sent.'
    WHERE status IN ('scheduled','preparing','processing') AND (lease_until IS NULL OR lease_until < ?)
      AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.id = instagram_jobs.post_id)`).bind(iso, iso).run();
  const row = await db.prepare(`SELECT * FROM instagram_jobs
    WHERE ((status = 'scheduled' AND due_at <= ?) OR status IN ('preparing','processing'))
      AND (lease_until IS NULL OR lease_until < ?)
    ORDER BY due_at LIMIT 1`).bind(iso, iso).first<Row>();
  if (!row) return null;
  const lease = new Date(now.getTime() + INSTAGRAM_CLAIM_MS).toISOString();
  const claim = await db.prepare(`UPDATE instagram_jobs SET lease_until = ?,
      status = CASE WHEN status = 'scheduled' THEN 'preparing' ELSE status END, updated_at = ?
    WHERE post_id = ? AND status = ? AND lease_until IS ? AND
      ((status = 'scheduled' AND due_at <= ?) OR status IN ('preparing','processing'))`)
    .bind(lease, iso, row.post_id, row.status, row.lease_until, iso).run();
  if ((claim.meta.changes ?? 0) !== 1) return null;
  return fromRow({ ...row, lease_until: lease, status: row.status === "scheduled" ? "preparing" : row.status });
}

/** Fenced write: only the lease holder may change its job. */
async function write(db: D1Database, job: InstagramJob, sets: Record<string, unknown>, from: InstagramJobStatus[]): Promise<boolean> {
  const entries = Object.entries({ ...sets, updated_at: new Date().toISOString() });
  const res = await db.prepare(`UPDATE instagram_jobs SET ${entries.map(([k]) => k + " = ?").join(", ")}
    WHERE post_id = ? AND lease_until = ? AND status IN (${from.map(() => "?").join(",")})`)
    .bind(...entries.map(([, v]) => v ?? null), job.post_id, job.lease_until, ...from).run();
  return (res.meta.changes ?? 0) === 1;
}

async function createContainer(env: Env, fields: Record<string, string>): Promise<string> {
  const res = await graphPost(env, `${env.IG_USER_ID}/media`, new URLSearchParams(fields));
  if (!res?.id) throw new Error("Instagram accepted the media but returned no container id.");
  return String(res.id);
}

/**
 * One cron step for at most one job. Bounded: up to ten child containers, one
 * parent and one status read or final send, well inside the subrequest budget.
 */
export async function processInstagramBatch(env: Env, now = new Date()): Promise<void> {
  if (!instagramConfigured(env)) return;
  const job = await claimDue(env.DB, now);
  if (!job) return;
  const fail = async (message: string, ambiguous: boolean, from: InstagramJobStatus[]) => {
    await write(env.DB, job, { status: "failed", error: message, ambiguous: ambiguous ? 1 : 0, lease_until: null }, from);
    await audit(env.DB, "cron", ambiguous ? "instagram-ambiguous" : "instagram-failed", job.post_id, message);
  };
  let sent = false;
  let remoteId: string | null = null;
  try {
    if (job.status === "preparing") {
      const children = [...job.children];
      if (job.kind === "CAROUSEL") {
        const stop = Math.min(job.items.length, children.length + INSTAGRAM_CHILDREN_PER_RUN);
        for (let i = children.length; i < stop; i++) {
          const id = await createContainer(env, { image_url: await createGrant(env, job.post_id, "photo", i), is_carousel_item: "true" });
          children.push(id);
          // Checkpoint each child: a crash never loses the order or count.
          if (!(await write(env.DB, job, { children: JSON.stringify(children) }, ["preparing"])))
            throw new Error("Instagram preparation lost its claim; nothing was published.");
        }
        if (children.length < job.items.length) {
          // Continue in the next run from the saved checkpoint.
          await write(env.DB, job, { lease_until: null }, ["preparing"]);
          return;
        }
      }
      const fields: Record<string, string> = { caption: job.caption };
      if (job.kind === "CAROUSEL") { fields.media_type = "CAROUSEL"; fields.children = children.join(","); }
      else if (job.kind === "REELS") { fields.media_type = "REELS"; fields.video_url = await createGrant(env, job.post_id, "video", 0); fields.share_to_feed = "true"; }
      else fields.image_url = await createGrant(env, job.post_id, "photo", 0);
      const container = await createContainer(env, fields);
      if (!(await write(env.DB, job, { status: "processing", container_id: container, processing_since: now.toISOString(), lease_until: null }, ["preparing"])))
        throw new Error("Instagram preparation lost its claim; nothing was published.");
      return;
    }
    // processing: wait until Meta has fetched and processed the media.
    const info = await graphGet(env, String(job.container_id), { fields: "status_code,status" });
    const code = String(info?.status_code ?? "");
    if (code === "ERROR" || code === "EXPIRED") {
      return await fail(`Instagram could not process the media (${code}${info?.status ? ": " + String(info.status) : ""}). Nothing was published.`, false, ["processing"]);
    }
    if (code !== "FINISHED") {
      if (job.processing_since && now.getTime() - Date.parse(job.processing_since) > INSTAGRAM_PROCESSING_LIMIT_MS)
        return await fail("Instagram was still processing the media after two hours. Nothing was published.", false, ["processing"]);
      await write(env.DB, job, { lease_until: null }, ["processing"]);
      return;
    }
    // One-way barrier: from here a lost answer may mean the post exists. The
    // send gets its own, longer lease; if it expires, the next cron run marks
    // the job unclear for the owner instead of leaving it stuck in `sending`.
    const sendLease = new Date(Date.now() + INSTAGRAM_SEND_LEASE_MS).toISOString();
    if (!(await write(env.DB, job, { status: "sending", lease_until: sendLease }, ["processing"])))
      throw new Error("Instagram publication lost its claim before sending; nothing was published.");
    job.lease_until = sendLease;
    sent = true;
    let mediaId: string;
    try {
      const res = await graphPost(env, `${env.IG_USER_ID}/media_publish`, new URLSearchParams({ creation_id: String(job.container_id) }));
      if (!res?.id) throw new Error("no media id returned");
      mediaId = String(res.id);
      remoteId = mediaId;
    } catch (e) {
      return await fail("The final Instagram publish request did not confirm (" + (e instanceof Error ? e.message : String(e)) +
        "). It may or may not be on Instagram. Check the GS Grimoire Instagram before doing anything; nothing will be resent automatically.", true, ["sending"]);
    }
    // Record the remote id before anything else can fail.
    if (!(await write(env.DB, job, { media_id: mediaId }, ["sending"]))) {
      // The send outlived its lease and was marked unclear. Record the real
      // result only while the owner has not decided; never undo their decision.
      const late = await env.DB.prepare(`UPDATE instagram_jobs SET status = 'published', media_id = ?, ambiguous = 0, error = NULL,
          lease_until = NULL, updated_at = ? WHERE post_id = ? AND status = 'failed' AND ambiguous = 1 AND media_id IS NULL`)
        .bind(mediaId, new Date().toISOString(), job.post_id).run();
      await audit(env.DB, "cron", (late.meta.changes ?? 0) === 1 ? "instagram-published-late" : "instagram-late-result-after-owner-decision",
        job.post_id, mediaId);
      return;
    }
    const permalink = (await graphGet(env, mediaId, { fields: "permalink" }).catch(() => null))?.permalink ?? null;
    await write(env.DB, job, { status: "published", permalink, error: null, lease_until: null }, ["sending"]);
    await env.DB.prepare("DELETE FROM instagram_media_grants WHERE post_id = ?").bind(job.post_id).run();
    await audit(env.DB, "cron", "instagram-published", job.post_id, mediaId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Before the barrier no post can exist yet. After it, any failure (even a
    // database one) is treated as unclear and is never resent automatically.
    if (sent) {
      // If Meta returned a post id but saving it failed, keep the id visible to the owner.
      await fail((remoteId ? `Instagram returned post id ${remoteId}, but GS Poster could not record it (` : "Instagram may already have this post (") + message + "). Check the GS Grimoire Instagram; nothing will be resent automatically.", true, ["sending"])
        .catch(() => undefined); // if this write also fails, the expired send lease surfaces it on the next run
    }
    else await fail(message, false, ["preparing", "processing"]);
  }
}

// ---------------------------------------------------------------- check_setup

export async function checkInstagram(env: Env): Promise<{ ok: boolean; username?: string; error?: string }> {
  if (!instagramConfigured(env)) return { ok: false, error: "IG_USER_ID is not set (or not a numeric account id), so Instagram stays manual." };
  try {
    const info = await graphGet(env, String(env.IG_USER_ID), { fields: "username" });
    return info?.username ? { ok: true, username: String(info.username) } : { ok: false, error: "Instagram returned no username for IG_USER_ID." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- page card

const LABEL: Record<InstagramJobStatus, string> = {
  scheduled: "Approved, waiting for its time", preparing: "Sending media to Instagram", processing: "Instagram is processing the media",
  sending: "Publishing now", published: "Published", failed: "Failed", cancelled: "Cancelled",
};

/** Status and PIN-gated controls. Every value is escaped. */
export function instagramJobCard(job: InstagramJob | null, postId: string, csrf: string, when: (iso: string) => string): string {
  if (!job) return "";
  const pinForm = (action: string, button: string, extra = "") => `<form method="post" action="/post/${esc(postId)}/${action}" class="ig-job-action">
      <input type="hidden" name="csrf" value="${esc(csrf)}">${extra}
      <label>Approval PIN<input name="pin" type="password" inputmode="numeric" autocomplete="off" required></label>
      <button type="submit">${esc(button)}</button></form>`;
  const kind = job.kind === "REELS" ? "Reel" : job.kind === "CAROUSEL" ? job.items.length + "-photo carousel" : "photo";
  const lines = [
    `<p><strong>${esc(LABEL[job.status])}</strong> · ${esc(kind)}${job.status === "scheduled" ? " · " + esc(when(job.due_at)) : ""}</p>`,
    job.permalink ? `<p><a href="${esc(job.permalink)}" target="_blank" rel="noopener noreferrer">Open on Instagram</a></p>` : "",
    job.error ? `<p class="err">${esc(job.error)}</p>` : "",
    job.status === "scheduled" ? pinForm("instagram-cancel", "Cancel Instagram post") : "",
    job.status === "failed" && !job.ambiguous ? pinForm("instagram-retry", "Try Instagram again") + pinForm("instagram-cancel", "Stop Instagram") : "",
    job.status === "failed" && job.ambiguous ? pinForm("instagram-close", "Close: it is not on Instagram",
      `<label><input type="checkbox" name="confirmed_not_on_instagram" value="1" required> I checked the GS Grimoire Instagram and this post is not there.</label>`) +
      `<p class="hint">If it is on Instagram, leave this as it is. Nothing will be sent again.</p>` : "",
  ];
  return `<section class="ed-card ig-job" aria-label="Instagram publishing"><h3>Instagram</h3>${lines.join("")}</section>`;
}
