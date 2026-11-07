/**
 * Approved Threads publishing. Same safety model as instagram-publish.ts:
 * - Only the signed-in, PIN-gated approval creates a job; it freezes the text
 *   and the exact photos (Instagram frames or Facebook photos).
 * - Cron claims one due job with a lease; containers are checkpointed; the
 *   final threads_publish sits behind a one-way `sending` barrier and an
 *   unclear result is never resent. The owner closes it with the PIN after
 *   checking Threads.
 * - Meta fetches each JPEG through a short-lived, hashed link that only works
 *   while the job is preparing or sending.
 * No Model Context Protocol tool calls anything in this file.
 */
import type { Env } from "./env.ts";
import { audit, ensureSchema, getPost, THREADS_JOBS_DDL, THREADS_TEXT_MAX, type Post, type ThreadsMedia } from "./db.ts";
import { fetchImage } from "./media.ts";
import { esc } from "./html.ts";
import { checkMessage } from "./validate.ts";
import { randomToken, sha256 } from "./session.ts";
import { renderInstagram, type InstagramFrame, type InstagramItem } from "./instagram.ts";
import { ensureThreadsSchema, renewThreadsToken, THREADS_GRAPH, threadsAccessToken, threadsConfigured, threadsConnection } from "./threads.ts";

export const THREADS_MEDIA_PATH = "/threads/media/";
export const THREADS_MAX_ITEMS = 20;
export const THREADS_LEASE_SECONDS = 6 * 3600;
export const THREADS_CLAIM_MS = 3 * 60_000;
export const THREADS_CHILDREN_PER_RUN = 5;
export const THREADS_PROCESSING_LIMIT_MS = 2 * 3600_000;
/** How long the final send may run before its result is treated as unclear. */
export const THREADS_SEND_LEASE_MS = 10 * 60_000;

export type ThreadsJobStatus = "scheduled" | "preparing" | "processing" | "sending" | "published" | "failed" | "cancelled";
export type ThreadsKind = "TEXT" | "IMAGE" | "CAROUSEL";
/** One frozen photo: a source URL and, for Instagram frames, how to render it. */
export interface ThreadsItem { url: string; ig?: InstagramItem; digest?: string }

export async function threadsPhotoDigest(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

export interface ThreadsJob {
  post_id: string; status: ThreadsJobStatus; kind: ThreadsKind; due_at: string; text: string;
  frame: InstagramFrame | null; items: ThreadsItem[]; children: string[]; container_id: string | null;
  processing_since: string | null; media_id: string | null; permalink: string | null; error: string | null;
  ambiguous: boolean; lease_until: string | null; created_by: string; updated_at: string;
  /** The Threads account the owner approved this job for. It never publishes anywhere else. */
  account_id: string; account_username: string; generation: string;
}
interface Row extends Omit<ThreadsJob, "items" | "children" | "ambiguous"> { items: string; children: string; ambiguous: number }
const fromRow = (r: Row): ThreadsJob => ({ ...r, items: JSON.parse(r.items || "[]"), children: JSON.parse(r.children || "[]"), ambiguous: r.ambiguous === 1 });

let ready = false;
export async function ensureThreadsJobs(db: D1Database): Promise<void> {
  if (ready) return;
  await ensureSchema(db);
  await db.batch([
    db.prepare(THREADS_JOBS_DDL),
    db.prepare("CREATE INDEX IF NOT EXISTS threads_jobs_due ON threads_jobs(status, due_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS threads_media_grants (token_hash TEXT PRIMARY KEY, post_id TEXT NOT NULL,
      item_index INTEGER NOT NULL, expires_at INTEGER NOT NULL, generation TEXT)`),
    db.prepare("CREATE INDEX IF NOT EXISTS threads_media_grants_post ON threads_media_grants(post_id)"),
  ]);
  for (const [table, definition] of [
    ["threads_jobs", "TEXT NOT NULL DEFAULT ''"],
    ["threads_media_grants", "TEXT"],
  ]) {
    const columns = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (!columns.results.some(column => column.name === "generation")) {
      try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN generation ${definition}`).run(); }
      catch (error) { if (!/duplicate column name/i.test(String(error))) throw error; }
    }
  }
  ready = true;
}

/** An approved Threads job that may still publish or whose result is unclear. */
export function threadsPending(job: ThreadsJob | null): boolean {
  return !!job && job.status !== "cancelled" && job.status !== "published";
}

/** Why a PIN-free draft change would be refused, or null when it is allowed. */
export function threadsFreezeProblem(job: ThreadsJob | null, cur: { scheduled_at: string | null },
  next: { scheduled_at: string | null; threads_enabled?: boolean }): string | null {
  if (!threadsPending(job)) return null;
  if (next.scheduled_at !== cur.scheduled_at)
    return "This post is approved for Threads, so its time is locked. Move it in the calendar with your PIN, or cancel Threads with your PIN first.";
  if (next.threads_enabled === false)
    return "This post is approved for Threads, so Threads cannot be switched off here. Cancel it with your PIN in the Threads card first.";
  return null;
}

export async function getThreadsJob(db: D1Database, postId: string): Promise<ThreadsJob | null> {
  await ensureThreadsJobs(db);
  const row = await db.prepare("SELECT * FROM threads_jobs WHERE post_id = ?").bind(postId).first<Row>();
  return row ? fromRow(row) : null;
}

/** The photos a Threads post would carry, resolved from the post at approval time. */
export function threadsItems(post: Pick<Post, "images" | "instagram" | "instagram_paused">, media: ThreadsMedia): { frame: InstagramFrame | null; items: ThreadsItem[] } {
  if (media === "instagram") {
    const ig = post.instagram ?? post.instagram_paused ?? null;
    return { frame: ig?.frame ?? null, items: (ig?.items ?? []).map((it) => ({ url: it.url, ig: it })) };
  }
  if (media === "facebook") return { frame: null, items: post.images.map((url) => ({ url })) };
  return { frame: null, items: [] };
}

export type ThreadsPlan =
  | { ok: true; kind: ThreadsKind; count: number; text: string; account: string; accountId: string }
  | { ok: false; offered: boolean; reason: string };

/** Read-only: can this approval queue Threads, and what would it post? */
export async function threadsReleasePlan(env: Env, post: Post, job: ThreadsJob | null): Promise<ThreadsPlan> {
  const th = post.threads;
  if (!th) return { ok: false, offered: false, reason: "Threads is not selected for this post." };
  const conn = threadsConfigured(env) ? await threadsConnection(env.DB) : null;
  if (!conn) return { ok: false, offered: false, reason: "Threads is not connected yet. Connect it in Threads settings." };
  if (job && job.status !== "cancelled") return { ok: false, offered: true, reason: job.status === "published"
    ? "This post is already on Threads. Make a new draft to post it again."
    : "Threads already has an approved job for this post. Cancel it in the Threads card first." };
  const { items } = threadsItems(post, th.media);
  const problems: string[] = [];
  if (!th.caption.trim() && !items.length) problems.push("write the Threads text");
  if (th.caption.length > THREADS_TEXT_MAX) problems.push(`the text is over ${THREADS_TEXT_MAX} characters`);
  if (th.media !== "none" && !items.length) problems.push(`the ${th.media === "instagram" ? "Instagram card" : "Facebook post"} has no photos`);
  if (th.media === "instagram" && (post.instagram ?? post.instagram_paused)?.video) problems.push("Threads cannot use the Instagram Reel; choose photos or text only");
  if (items.length > THREADS_MAX_ITEMS) problems.push(`at most ${THREADS_MAX_ITEMS} photos`);
  problems.push(...checkMessage(th.caption, { hasImages: items.length > 0 }).errors.map((e) => e.replace(/\.$/, "")));
  if (problems.length) return { ok: false, offered: true, reason: "Fix in the Threads card and save first: " + problems.join("; ") + "." };
  const kind: ThreadsKind = !items.length ? "TEXT" : items.length === 1 ? "IMAGE" : "CAROUSEL";
  return { ok: true, kind, count: items.length, text: th.caption, account: conn.username || conn.user_id, accountId: conn.user_id };
}

/** Called only from the PIN-gated approval, fenced on the version the owner reviewed. */
export async function queueThreadsOnApproval(env: Env, postId: string, expectedVersion: string, dueAt: Date, actor: string, expectedAccountId: string, photoDigests: string[]): Promise<ThreadsJob> {
  const post = await getPost(env.DB, postId);
  if (!post || post.updated_at !== expectedVersion) throw new Error("The draft changed. Reload before approving.");
  await ensureThreadsJobs(env.DB);
  const plan = await threadsReleasePlan(env, post, await getThreadsJob(env.DB, postId));
  if (!plan.ok) throw new Error(plan.reason);
  const { frame, items } = threadsItems(post, post.threads!.media);
  if (photoDigests.length !== items.length || photoDigests.some(digest => !/^[0-9a-f]{64}$/.test(digest)))
    throw new Error("The Threads photos could not be verified. Reload and review them before approving.");
  const frozenItems = items.map((item, index) => ({ ...item, digest: photoDigests[index] }));
  // The owner approves the account shown on the form. Fence that same ID
  // through planning and the atomic insert so a reconnect cannot change it.
  if (plan.accountId !== expectedAccountId)
    throw new Error("The Threads account changed. Reload and review the new account before approving.");
  const now = new Date().toISOString();
  const res = await env.DB.prepare(`INSERT INTO threads_jobs (post_id, status, kind, due_at, text, frame, items, created_by, updated_at, account_id, account_username, generation)
    SELECT ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM posts
      WHERE id = ? AND updated_at = ? AND status = 'draft' AND approved_at IS NULL
        AND EXISTS (SELECT 1 FROM threads_targets t WHERE t.post_id = posts.id AND t.status = 'draft')
        AND EXISTS (SELECT 1 FROM threads_accounts a WHERE a.account_key = 'primary' AND a.user_id = ?)
    ON CONFLICT(post_id) DO UPDATE SET status = 'scheduled', kind = excluded.kind, due_at = excluded.due_at, text = excluded.text,
      frame = excluded.frame, items = excluded.items, children = '[]', container_id = NULL, processing_since = NULL,
      media_id = NULL, permalink = NULL, error = NULL, ambiguous = 0, lease_until = NULL, created_by = excluded.created_by,
      updated_at = excluded.updated_at, account_id = excluded.account_id, account_username = excluded.account_username, generation = excluded.generation
    WHERE threads_jobs.status = 'cancelled'`)
    .bind(postId, plan.kind, dueAt.toISOString(), post.threads!.caption, frame, JSON.stringify(frozenItems), actor, now,
      plan.accountId, plan.account, randomToken(), postId, expectedVersion, expectedAccountId).run();
  if ((res.meta.changes ?? 0) !== 1) throw new Error("Threads could not be queued: the draft or connected account changed, or a job already exists. Reload.");
  await audit(env.DB, actor, "threads-queued", postId, plan.kind + " at " + dueAt.toISOString() + " for @" + plan.account);
  return (await getThreadsJob(env.DB, postId))!;
}

export async function cancelThreadsJob(env: Env, postId: string, actor: string): Promise<boolean> {
  await ensureThreadsJobs(env.DB);
  const now = new Date().toISOString();
  const res = await env.DB.prepare(`UPDATE threads_jobs SET status = 'cancelled', lease_until = NULL, updated_at = ?
    WHERE post_id = ? AND (status = 'scheduled' OR (status = 'failed' AND ambiguous = 0)
      OR (status IN ('preparing','processing') AND (lease_until IS NULL OR lease_until < ?)))`).bind(now, postId, now).run();
  if ((res.meta.changes ?? 0) !== 1) return false;
  await pruneThreadsGrants(env.DB, postId);
  await audit(env.DB, actor, "threads-cancelled", postId);
  return true;
}
export async function closeAmbiguousThreadsJob(env: Env, postId: string, actor: string): Promise<boolean> {
  await ensureThreadsJobs(env.DB);
  const res = await env.DB.prepare(`UPDATE threads_jobs SET status = 'cancelled', lease_until = NULL, updated_at = ?
    WHERE post_id = ? AND status = 'failed' AND ambiguous = 1 AND media_id IS NULL`).bind(new Date().toISOString(), postId).run();
  if ((res.meta.changes ?? 0) !== 1) return false;
  await pruneThreadsGrants(env.DB, postId);
  await audit(env.DB, actor, "threads-ambiguous-closed", postId, "owner checked Threads: not posted");
  return true;
}
export async function retryThreadsJob(env: Env, postId: string, actor: string): Promise<boolean> {
  await ensureThreadsJobs(env.DB);
  const now = new Date().toISOString();
  const res = await env.DB.prepare(`UPDATE threads_jobs SET status = 'scheduled', due_at = ?, children = '[]', container_id = NULL,
      processing_since = NULL, error = NULL, lease_until = NULL, updated_at = ?, generation = ?
    WHERE post_id = ? AND status = 'failed' AND ambiguous = 0 AND media_id IS NULL`).bind(now, now, randomToken(), postId).run();
  if ((res.meta.changes ?? 0) !== 1) return false;
  await pruneThreadsGrants(env.DB, postId);
  await audit(env.DB, actor, "threads-retry", postId);
  return true;
}
export async function cancelScheduledThreads(db: D1Database, postId: string): Promise<boolean> {
  await ensureThreadsJobs(db);
  const res = await db.prepare("UPDATE threads_jobs SET status = 'cancelled', updated_at = ? WHERE post_id = ? AND status = 'scheduled'")
    .bind(new Date().toISOString(), postId).run();
  return (res.meta.changes ?? 0) === 1;
}

// ---------------------------------------------------------------- media links

async function pruneThreadsGrants(db: D1Database, postId: string): Promise<void> {
  await db.prepare(`DELETE FROM threads_media_grants WHERE post_id = ?
    AND NOT EXISTS (SELECT 1 FROM threads_jobs j WHERE j.post_id = threads_media_grants.post_id
      AND j.generation = threads_media_grants.generation AND j.status IN ('preparing','processing','sending'))`)
    .bind(postId).run();
}

async function createGrant(env: Env, job: ThreadsJob, index: number): Promise<string> {
  const token = randomToken();
  const created = await env.DB.prepare(`INSERT INTO threads_media_grants
    (token_hash, post_id, item_index, expires_at, generation)
    SELECT ?, post_id, ?, ?, generation FROM threads_jobs
    WHERE post_id = ? AND generation = ? AND status = 'preparing' AND lease_until = ?
      AND EXISTS (SELECT 1 FROM threads_accounts a WHERE a.account_key = 'primary' AND a.user_id = threads_jobs.account_id)`)
    .bind(await sha256(token), index, Math.floor(Date.now() / 1000) + THREADS_LEASE_SECONDS,
      job.post_id, job.generation, job.lease_until).run();
  if (created.meta.changes !== 1) throw new Error("Threads preparation lost its claim; nothing was published.");
  return (env.PUBLIC_ORIGIN || "https://gs-poster.goofyspook.workers.dev").replace(/\/$/, "") + THREADS_MEDIA_PATH + token + ".jpg";
}

/** Public, unauthenticated: one frozen, approved photo as JPEG for Meta's fetcher. */
export async function serveThreadsMedia(req: Request, env: Env): Promise<Response> {
  const headers = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" };
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
  const m = /^\/threads\/media\/([A-Za-z0-9_-]{32,90})\.jpg$/.exec(new URL(req.url).pathname);
  const notFound = () => new Response("Not found", { status: 404, headers });
  if (!m) return notFound();
  await ensureThreadsJobs(env.DB);
  await ensureThreadsSchema(env.DB);
  const grant = await env.DB.prepare(`SELECT j.frame, json_extract(j.items, '$[' || g.item_index || ']') AS item
    FROM threads_media_grants g
    JOIN threads_jobs j ON j.post_id = g.post_id AND j.generation = g.generation
    WHERE g.token_hash = ? AND g.expires_at > ? AND j.status IN ('preparing','processing','sending')
      AND EXISTS (SELECT 1 FROM threads_accounts a WHERE a.account_key = 'primary' AND a.user_id = j.account_id)`)
    .bind(await sha256(m[1]), Math.floor(Date.now() / 1000)).first<{ frame: InstagramFrame | null; item: string | null }>();
  if (!grant?.item) return notFound();
  const item: ThreadsItem = JSON.parse(grant.item);
  if (!item.digest) return notFound();
  if (req.method === "HEAD") return new Response(null, { headers: { ...headers, "Content-Type": "image/jpeg" } });
  try {
    if (!env.IMAGES) throw new Error("Image renderer unavailable");
    const img = await fetchImage(env, item.url);
    if (await threadsPhotoDigest(img.bytes) !== item.digest) return notFound();
    let jpeg: Uint8Array;
    if (item.ig && grant.frame) jpeg = await renderInstagram(env.IMAGES, new Uint8Array(img.bytes), grant.frame, item.ig);
    else {
      // Re-encode as JPEG: strips metadata and keeps within Threads' width limits.
      const out = await env.IMAGES.input(new Blob([img.bytes]).stream()).transform({ width: 1440, fit: "scale-down" }).output({ format: "image/jpeg" });
      jpeg = new Uint8Array(await out.response().arrayBuffer());
    }
    return new Response(jpeg, { headers: { ...headers, "Content-Type": "image/jpeg", "Content-Length": String(jpeg.byteLength) } });
  } catch {
    return new Response("Media unavailable", { status: 502, headers });
  }
}

// ---------------------------------------------------------------- Graph calls

/** One Threads call with the credentials read once for the whole run. */
type Creds = { token: string; userId: string };
async function graph(creds: Creds, method: "GET" | "POST", path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const { token } = creds;
  const q = new URLSearchParams({ ...params, access_token: token });
  const res = method === "GET"
    ? await fetch(`${THREADS_GRAPH}/v1.0/${path}?${q}`, { redirect: "manual" })
    : await fetch(`${THREADS_GRAPH}/v1.0/${path}`, { method: "POST", body: q, redirect: "manual" });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok || body.error) {
    const e = (body.error ?? {}) as { message?: string; error_user_msg?: string };
    throw new Error("Threads said: " + String(e.error_user_msg || e.message || "HTTP " + res.status).slice(0, 300));
  }
  return body;
}

// ---------------------------------------------------------------- cron

async function claimDue(db: D1Database, now: Date): Promise<ThreadsJob | null> {
  await ensureThreadsJobs(db);
  const iso = now.toISOString();
  // Earlier workers could store an ID before updating the job to published.
  await db.prepare(`UPDATE threads_jobs SET status = 'published', ambiguous = 0, lease_until = NULL, error = NULL, updated_at = ?
    WHERE media_id IS NOT NULL AND (status = 'sending' OR (status = 'failed' AND ambiguous = 1))`).bind(iso).run();
  // An interrupted final send becomes an unclear, owner-only result; never resent.
  await db.prepare(`UPDATE threads_jobs SET status = 'failed', ambiguous = 1, lease_until = NULL, updated_at = ?,
      error = 'The final Threads publish request was interrupted before GS Poster recorded its answer. It may or may not be on Threads. Check the GS Grimoire Threads profile; nothing will be resent automatically.'
    WHERE status = 'sending' AND (lease_until IS NULL OR lease_until < ?)`).bind(iso, iso).run();
  // Legacy safety net for posts deleted before deletion was guarded.
  await db.prepare(`UPDATE threads_jobs SET status = 'cancelled', lease_until = NULL, updated_at = ?,
      error = 'The post was deleted before it reached Threads. Nothing was sent.'
    WHERE status IN ('scheduled','preparing','processing') AND (lease_until IS NULL OR lease_until < ?)
      AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.id = threads_jobs.post_id)`).bind(iso, iso).run();
  const row = await db.prepare(`SELECT * FROM threads_jobs WHERE ((status = 'scheduled' AND due_at <= ?) OR status IN ('preparing','processing'))
      AND (lease_until IS NULL OR lease_until < ?) ORDER BY due_at LIMIT 1`).bind(iso, iso).first<Row>();
  if (!row) return null;
  const lease = new Date(now.getTime() + THREADS_CLAIM_MS).toISOString();
  const claim = await db.prepare(`UPDATE threads_jobs SET lease_until = ?, status = CASE WHEN status = 'scheduled' THEN 'preparing' ELSE status END,
      updated_at = ? WHERE post_id = ? AND generation = ? AND status = ? AND lease_until IS ? AND ((status = 'scheduled' AND due_at <= ?) OR status IN ('preparing','processing'))`)
    .bind(lease, iso, row.post_id, row.generation, row.status, row.lease_until, iso).run();
  if ((claim.meta.changes ?? 0) !== 1) return null;
  return fromRow({ ...row, lease_until: lease, status: row.status === "scheduled" ? "preparing" : row.status });
}

async function write(db: D1Database, job: ThreadsJob, sets: Record<string, unknown>, from: ThreadsJobStatus[]): Promise<boolean> {
  const entries = Object.entries({ ...sets, updated_at: new Date().toISOString() });
  const res = await db.prepare(`UPDATE threads_jobs SET ${entries.map(([k]) => k + " = ?").join(", ")}
    WHERE post_id = ? AND generation = ? AND lease_until = ? AND status IN (${from.map(() => "?").join(",")})`)
    .bind(...entries.map(([, v]) => v ?? null), job.post_id, job.generation, job.lease_until, ...from).run();
  return (res.meta.changes ?? 0) === 1;
}

async function container(creds: Creds, fields: Record<string, string>): Promise<string> {
  const res = await graph(creds, "POST", `${creds.userId}/threads`, fields);
  if (typeof res.id !== "string" && typeof res.id !== "number") throw new Error("Threads accepted the media but returned no container id.");
  return String(res.id);
}

/** One bounded cron step for at most one job. */
export async function processThreadsBatch(env: Env, now = new Date()): Promise<void> {
  if (!threadsConfigured(env)) return;
  const job = await claimDue(env.DB, now);
  if (!job) return;
  const fail = async (message: string, ambiguous: boolean, from: ThreadsJobStatus[]) => {
    await write(env.DB, job, { status: "failed", error: message, ambiguous: ambiguous ? 1 : 0, lease_until: null }, from);
    await audit(env.DB, "cron", ambiguous ? "threads-ambiguous" : "threads-failed", job.post_id, message);
  };
  let sent = false;
  let remoteId: string | null = null;
  try {
    // Read the sign-in once for this run and use only it, so a reconnect during
    // the run cannot switch accounts mid-way. It must be the approved account.
    const creds = await threadsAccessToken(env);
    if (creds.userId !== job.account_id) {
      const where = job.status === "processing" ? "Its prepared media stays unpublished. " : "";
      return await fail(`This post was approved for Threads account @${job.account_username || job.account_id}, but a different Threads account is connected now. Nothing was sent. ${where}Reconnect @${job.account_username || job.account_id} and press Try Threads again, or cancel it and approve it again for the new account.`, false, ["preparing", "processing"]);
    }
    const userId = creds.userId;
    if (job.status === "preparing") {
      const children = [...job.children];
      if (job.kind === "CAROUSEL") {
        const stop = Math.min(job.items.length, children.length + THREADS_CHILDREN_PER_RUN);
        for (let i = children.length; i < stop; i++) {
          children.push(await container(creds, { media_type: "IMAGE", image_url: await createGrant(env, job, i), is_carousel_item: "true" }));
          if (!(await write(env.DB, job, { children: JSON.stringify(children) }, ["preparing"])))
            throw new Error("Threads preparation lost its claim; nothing was published.");
        }
        if (children.length < job.items.length) { await write(env.DB, job, { lease_until: null }, ["preparing"]); return; }
      }
      const fields: Record<string, string> = { text: job.text };
      if (job.kind === "CAROUSEL") { fields.media_type = "CAROUSEL"; fields.children = children.join(","); }
      else if (job.kind === "IMAGE") { fields.media_type = "IMAGE"; fields.image_url = await createGrant(env, job, 0); }
      else fields.media_type = "TEXT";
      const id = await container(creds, fields);
      if (!(await write(env.DB, job, { status: "processing", container_id: id, processing_since: now.toISOString(), lease_until: null }, ["preparing"])))
        throw new Error("Threads preparation lost its claim; nothing was published.");
      return;
    }
    const info = await graph(creds, "GET", String(job.container_id), { fields: "status,error_message" });
    const code = String(info.status ?? "");
    if (code === "ERROR" || code === "EXPIRED")
      return await fail(`Threads could not process the post (${code}${info.error_message ? ": " + String(info.error_message) : ""}). Nothing was published.`, false, ["processing"]);
    if (code !== "FINISHED") {
      if (job.processing_since && now.getTime() - Date.parse(job.processing_since) > THREADS_PROCESSING_LIMIT_MS)
        return await fail("Threads was still processing the post after two hours. Nothing was published.", false, ["processing"]);
      await write(env.DB, job, { lease_until: null }, ["processing"]);
      return;
    }
    const sendLease = new Date(Date.now() + THREADS_SEND_LEASE_MS).toISOString();
    // The one-way barrier is only crossed while the approved account is still
    // connected, checked in the same statement: a disconnect (or a switch to
    // another account) since this run read its sign-in stops the send here.
    const barrier = await env.DB.prepare(`UPDATE threads_jobs SET status = 'sending', lease_until = ?, updated_at = ?
      WHERE post_id = ? AND generation = ? AND lease_until = ? AND status = 'processing'
        AND EXISTS (SELECT 1 FROM threads_accounts a WHERE a.account_key = 'primary' AND a.user_id = threads_jobs.account_id)`)
      .bind(sendLease, new Date().toISOString(), job.post_id, job.generation, job.lease_until).run();
    if ((barrier.meta.changes ?? 0) !== 1) {
      const stillOurs = await env.DB.prepare("SELECT 1 AS x FROM threads_jobs WHERE post_id = ? AND generation = ? AND lease_until = ? AND status = 'processing'")
        .bind(job.post_id, job.generation, job.lease_until).first();
      if (stillOurs) return await fail(`The approved Threads account @${job.account_username || job.account_id} was disconnected before the final send. Nothing was sent. Reconnect it and press Try Threads again, or cancel this post.`, false, ["processing"]);
      throw new Error("Threads publication lost its claim before sending; nothing was published.");
    }
    job.lease_until = sendLease;
    sent = true;
    let mediaId: string;
    try {
      const res = await graph(creds, "POST", `${userId}/threads_publish`, { creation_id: String(job.container_id) });
      if (!res.id) throw new Error("no post id returned");
      mediaId = String(res.id);
      remoteId = mediaId;
    } catch (e) {
      return await fail("The final Threads publish request did not confirm (" + (e instanceof Error ? e.message : String(e)) +
        "). It may or may not be on Threads. Check the GS Grimoire Threads profile before doing anything; nothing will be resent automatically.", true, ["sending"]);
    }
    if (!(await write(env.DB, job, { status: "published", media_id: mediaId, error: null, lease_until: null }, ["sending"]))) {
      // Marked unclear after the send lease expired: record the real post only
      // while the owner has not decided, and never undo their decision.
      const late = await env.DB.prepare(`UPDATE threads_jobs SET status = 'published', media_id = ?, ambiguous = 0, error = NULL,
          lease_until = NULL, updated_at = ? WHERE post_id = ? AND generation = ? AND status = 'failed' AND ambiguous = 1 AND media_id IS NULL`)
        .bind(mediaId, new Date().toISOString(), job.post_id, job.generation).run();
      await audit(env.DB, "cron", (late.meta.changes ?? 0) === 1 ? "threads-published-late" : "threads-late-result-after-owner-decision",
        job.post_id, mediaId);
      return;
    }
    const permalink = (await graph(creds, "GET", mediaId, { fields: "permalink" }).catch(() => null))?.permalink ?? null;
    if (permalink) {
      await env.DB.prepare(`UPDATE threads_jobs SET permalink = ?, updated_at = ?
        WHERE post_id = ? AND generation = ? AND status = 'published' AND media_id = ?`)
        .bind(String(permalink), new Date().toISOString(), job.post_id, job.generation, mediaId).run();
    }
    await pruneThreadsGrants(env.DB, job.post_id);
    await audit(env.DB, "cron", "threads-published", job.post_id, mediaId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (sent) await fail((remoteId ? `Threads returned post id ${remoteId}, but GS Poster could not record it (` : "Threads may already have this post (") +
      message + "). Check the GS Grimoire Threads profile; nothing will be resent automatically.", true, ["sending"])
      .catch(() => undefined); // if this write also fails, the expired send lease surfaces it on the next run
    else await fail(message, false, ["preparing", "processing"]);
  }
}

/**
 * The Threads part of the scheduled handler. Renewal failures are recorded
 * but never stop due posts from being processed with the still-valid token.
 * Throws afterwards, so the cron run is still reported as failed.
 */
export async function runThreadsCron(env: Env, now = new Date()): Promise<void> {
  let renewalError: unknown = null;
  try { await renewThreadsToken(env, Math.floor(now.getTime() / 1000)); }
  catch (e) {
    renewalError = e;
    await audit(env.DB, "cron", "threads-renewal-failed", null, e instanceof Error ? e.message.slice(0, 200) : "unknown").catch(() => undefined);
  }
  await processThreadsBatch(env, now);
  if (renewalError) throw renewalError;
}

export async function checkThreads(env: Env): Promise<{ ok: boolean; username?: string; expires_at?: string; error?: string }> {
  if (!threadsConfigured(env)) return { ok: false, error: "THREADS_APP_ID or THREADS_APP_SECRET is not set." };
  const conn = await threadsConnection(env.DB);
  if (!conn) return { ok: false, error: "Threads is not connected. Use Connect Threads in Threads settings." };
  try {
    const me = await graph(await threadsAccessToken(env), "GET", "me", { fields: "username" });
    return { ok: true, username: String(me.username ?? conn.username), expires_at: new Date(conn.expires_at * 1000).toISOString() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- page card

const LABEL: Record<ThreadsJobStatus, string> = {
  scheduled: "Approved, waiting for its time", preparing: "Sending media to Threads", processing: "Threads is processing the post",
  sending: "Publishing now", published: "Published", failed: "Failed", cancelled: "Cancelled",
};
export function threadsJobCard(job: ThreadsJob | null, postId: string, csrf: string, when: (iso: string) => string): string {
  if (!job) return "";
  const pinForm = (action: string, button: string, extra = "") => `<form method="post" action="/post/${esc(postId)}/${action}" class="th-job-action">
      <input type="hidden" name="csrf" value="${esc(csrf)}">${extra}
      <label>Approval PIN<input name="pin" type="password" inputmode="numeric" autocomplete="off" required></label>
      <button type="submit">${esc(button)}</button></form>`;
  const kind = (job.kind === "CAROUSEL" ? job.items.length + "-photo carousel" : job.kind === "IMAGE" ? "photo post" : "text post") +
    " for @" + (job.account_username || job.account_id);
  return `<section class="ed-card th-job" aria-label="Threads publishing"><h3>Threads</h3>
    <p><strong>${esc(LABEL[job.status])}</strong> · ${esc(kind)}${job.status === "scheduled" ? " · " + esc(when(job.due_at)) : ""}</p>
    ${job.permalink ? `<p><a href="${esc(job.permalink)}" target="_blank" rel="noopener noreferrer">Open on Threads</a></p>` : ""}
    ${job.error ? `<p class="err">${esc(job.error)}</p>` : ""}
    ${threadsPending(job) ? `<p class="hint">This approved Threads post is frozen. Editing the draft does not change it, and its time and the Threads switch are locked. To change it, cancel it with your PIN and approve again.</p>` : ""}
    ${job.status === "scheduled" ? pinForm("threads-cancel", "Cancel Threads post") : ""}
    ${job.status === "failed" && !job.ambiguous ? pinForm("threads-retry", "Try Threads again") + pinForm("threads-cancel", "Stop Threads") : ""}
    ${job.status === "failed" && job.ambiguous ? pinForm("threads-close", "Close: it is not on Threads",
      `<label><input type="checkbox" name="confirmed_not_on_threads" value="1" required> I checked the GS Grimoire Threads profile and this post is not there.</label>`) +
      `<p class="hint">If it is on Threads, leave this as it is. Nothing will be sent again.</p>` : ""}
  </section>`;
}
