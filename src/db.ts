/**
 * Posts, audit log and PIN attempts, in D1. D1 is strongly consistent, so the
 * draft → publishing claim below is atomic and a double-tap on Approve cannot
 * post twice.
 */

export interface BlueskyDraft {
  caption: string;
  images: Array<{ url: string; alt: string }>;
  patreon: { url: string; title: string; description: string } | null;
}

export type BlueskyStatus = "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";
export interface BlueskyTarget extends BlueskyDraft {
  status: BlueskyStatus;
  uri: string | null;
  cid: string | null;
  card_uri: string | null;
  permalink: string | null;
  error: string | null;
}

export type PostStatus =
  | "draft" // waiting for Gus
  | "rejected" // Gus said no; Claude can revise it back to draft
  | "publishing" // claimed by an approval, talking to Facebook
  | "scheduled" // on Facebook's schedule
  | "published"
  | "failed"
  | "cancelled";

export interface Post {
  id: string;
  created_at: string;
  updated_at: string;
  status: PostStatus;
  label: string | null;
  release: string | null;
  message: string;
  link: string | null;
  images: string[];
  scheduled_at: string | null;
  fb_post_id: string | null;
  permalink: string | null;
  note: string | null;
  error: string | null;
  created_by: string | null;
  approved_at: string | null;
  facebook_enabled: boolean;
  bluesky: BlueskyTarget | null;
}

interface Row extends Omit<Post, "images" | "facebook_enabled" | "bluesky"> {
  images: string;
  bs_caption: string | null;
  bs_images: string | null;
  bs_patreon: string | null;
  bs_facebook_enabled: number | null;
  bs_status: BlueskyStatus | null;
  bs_uri: string | null;
  bs_cid: string | null;
  bs_card_uri: string | null;
  bs_permalink: string | null;
  bs_error: string | null;
}

const POST_SELECT = `SELECT p.*, b.caption AS bs_caption, b.images AS bs_images,
 b.patreon AS bs_patreon, b.facebook_enabled AS bs_facebook_enabled,
 b.status AS bs_status, b.uri AS bs_uri, b.cid AS bs_cid,
 b.card_uri AS bs_card_uri, b.permalink AS bs_permalink, b.error AS bs_error
 FROM posts p LEFT JOIN bluesky_targets b ON p.id = b.post_id`;

let schemaReady = false;

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      label TEXT,
      release TEXT,
      message TEXT NOT NULL,
      link TEXT,
      images TEXT NOT NULL DEFAULT '[]',
      scheduled_at TEXT,
      fb_post_id TEXT,
      permalink TEXT,
      note TEXT,
      error TEXT,
      created_by TEXT,
      approved_at TEXT
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS posts_status ON posts(status, created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS audit (
      ts TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      post_id TEXT,
      detail TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS pin_failures (ts INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS bluesky_targets (
      post_id TEXT PRIMARY KEY,
      caption TEXT NOT NULL,
      images TEXT NOT NULL DEFAULT '[]',
      patreon TEXT,
      facebook_enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      uri TEXT,
      cid TEXT,
      card_uri TEXT,
      permalink TEXT,
      error TEXT,
      started_at TEXT
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS bluesky_due ON bluesky_targets(status)`),
  ]);
  schemaReady = true;
}

function fromRow(r: Row): Post {
  return {
    ...r,
    images: JSON.parse(r.images || "[]"),
    facebook_enabled: r.bs_caption === null ? true : r.bs_facebook_enabled !== 0,
    bluesky: r.bs_caption === null ? null : {
      caption: r.bs_caption,
      images: JSON.parse(r.bs_images || "[]"),
      patreon: r.bs_patreon ? JSON.parse(r.bs_patreon) : null,
      status: r.bs_status!,
      uri: r.bs_uri,
      cid: r.bs_cid,
      card_uri: r.bs_card_uri,
      permalink: r.bs_permalink,
      error: r.bs_error,
    },
  };
}

export function newId(): string {
  const t = Date.now().toString(36);
  const r = crypto.getRandomValues(new Uint8Array(5));
  return `p_${t}${Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface NewPost {
  message: string;
  link?: string | null;
  images: string[];
  scheduled_at: string | null;
  label?: string | null;
  release?: string | null;
  created_by: string;
  bluesky?: BlueskyDraft | null;
  facebook_enabled?: boolean;
}

export async function createPost(db: D1Database, p: NewPost): Promise<Post> {
  await ensureSchema(db);
  const now = new Date().toISOString();
  const id = newId();
  const inserts = [
    db.prepare(`INSERT INTO posts (id, created_at, updated_at, status, label, release, message, link, images, scheduled_at, created_by)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, now, now, p.label ?? null, p.release ?? null, p.message, p.link ?? null, JSON.stringify(p.images), p.scheduled_at, p.created_by),
  ];
  if (p.bluesky) inserts.push(db.prepare(`INSERT INTO bluesky_targets
      (post_id, caption, images, patreon, facebook_enabled) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, p.bluesky.caption, JSON.stringify(p.bluesky.images),
      p.bluesky.patreon ? JSON.stringify(p.bluesky.patreon) : null, p.facebook_enabled === false ? 0 : 1));
  await db.batch(inserts);
  return (await getPost(db, id))!;
}

export async function getPost(db: D1Database, id: string): Promise<Post | null> {
  await ensureSchema(db);
  const r = await db.prepare(POST_SELECT + " WHERE p.id = ?").bind(id).first<Row>();
  return r ? fromRow(r) : null;
}

export async function listPosts(db: D1Database, opts: { status?: PostStatus; limit?: number } = {}): Promise<Post[]> {
  await ensureSchema(db);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const stmt = opts.status
    ? db.prepare(POST_SELECT + " WHERE p.status = ? ORDER BY p.created_at DESC LIMIT ?").bind(opts.status, limit)
    : db.prepare(POST_SELECT + " ORDER BY p.created_at DESC LIMIT ?").bind(limit);
  const { results } = await stmt.all<Row>();
  return results.map(fromRow);
}

type Patch = Partial<Omit<Post, "id" | "created_at">>;

export async function updatePost(db: D1Database, id: string, patch: Patch, onlyIfStatus?: PostStatus[]): Promise<boolean> {
  await ensureSchema(db);
  const fields = Object.entries({ ...patch, updated_at: new Date().toISOString() });
  const sets = fields.map(([k]) => `${k} = ?`).join(", ");
  const values = fields.map(([k, v]) => (k === "images" ? JSON.stringify(v) : (v ?? null)));
  let sql = `UPDATE posts SET ${sets} WHERE id = ?`;
  const binds: unknown[] = [...values, id];
  if (onlyIfStatus?.length) {
    sql += ` AND status IN (${onlyIfStatus.map(() => "?").join(", ")})`;
    binds.push(...onlyIfStatus);
  }
  const res = await db.prepare(sql).bind(...binds).run();
  return (res.meta.changes ?? 0) > 0;
}


/** Draft-only Bluesky edits. Non-Bluesky drafts always publish to Facebook. */
export async function saveBlueskyDraft(
  db: D1Database, id: string, draft: BlueskyDraft | null, facebookEnabled: boolean,
): Promise<boolean> {
  await ensureSchema(db);
  const allowed = await db.prepare("SELECT status FROM posts WHERE id = ?").bind(id).first<{ status: PostStatus }>();
  if (!allowed || !["draft", "rejected"].includes(allowed.status)) return false;
  if (!draft) {
    await db.prepare("DELETE FROM bluesky_targets WHERE post_id = ? AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND status IN ('draft','rejected'))")
      .bind(id, id).run();
    return true;
  }
  const result = await db.prepare(`INSERT INTO bluesky_targets (post_id, caption, images, patreon, facebook_enabled)
    SELECT ?, ?, ?, ?, ? FROM posts WHERE id = ? AND status IN ('draft','rejected')
    ON CONFLICT(post_id) DO UPDATE SET
      caption = excluded.caption, images = excluded.images,
      patreon = excluded.patreon, facebook_enabled = excluded.facebook_enabled,
      status = 'draft', uri = NULL, cid = NULL, card_uri = NULL, permalink = NULL, error = NULL
    WHERE EXISTS (SELECT 1 FROM posts WHERE id = ? AND status IN ('draft','rejected'))`)
    .bind(id, draft.caption, JSON.stringify(draft.images),
      draft.patreon ? JSON.stringify(draft.patreon) : null, facebookEnabled ? 1 : 0, id, id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function setBlueskyStatus(
  db: D1Database, id: string,
  patch: Partial<Pick<BlueskyTarget, "status" | "uri" | "cid" | "card_uri" | "permalink" | "error">>,
  onlyStatuses?: BlueskyStatus[],
): Promise<boolean> {
  await ensureSchema(db);
  const fields = Object.entries(patch);
  if (!fields.length) return false;
  const sets = fields.map(([k]) => k + " = ?").join(", ");
  const binds: unknown[] = [...fields.map(([, v]) => v ?? null), id];
  let sql = "UPDATE bluesky_targets SET " + sets + " WHERE post_id = ?";
  if (onlyStatuses?.length) {
    sql += " AND status IN (" + onlyStatuses.map(() => "?").join(",") + ")";
    binds.push(...onlyStatuses);
  }
  const result = await db.prepare(sql).bind(...binds).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function claimDueBluesky(db: D1Database, id: string, now: string): Promise<boolean> {
  await ensureSchema(db);
  const stale = new Date(Date.parse(now) - 15 * 60 * 1000).toISOString();
  const result = await db.prepare(`UPDATE bluesky_targets SET status = 'publishing', started_at = ?
    WHERE post_id = ? AND (status = 'scheduled' OR (status = 'publishing' AND started_at <= ?))
    AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND approved_at IS NOT NULL
      AND scheduled_at IS NOT NULL AND scheduled_at <= ? AND status IN ('scheduled','published','failed'))`)
    .bind(now, id, stale, id, now).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function dueBlueskyIds(db: D1Database, now: string): Promise<string[]> {
  await ensureSchema(db);
  const stale = new Date(Date.parse(now) - 15 * 60 * 1000).toISOString();
  const result = await db.prepare(`SELECT p.id AS id FROM posts p
    JOIN bluesky_targets b ON b.post_id = p.id
    WHERE (b.status = 'scheduled' OR (b.status = 'publishing' AND b.started_at <= ?))
      AND p.approved_at IS NOT NULL AND p.scheduled_at IS NOT NULL AND p.scheduled_at <= ?
      AND p.status IN ('scheduled','published','failed')
    ORDER BY p.scheduled_at LIMIT 20`).bind(stale, now).all<{ id: string }>();
  return result.results.map((r) => r.id);
}

export async function claimFailedBluesky(db: D1Database, id: string): Promise<boolean> {
  await ensureSchema(db);
  const result = await db.prepare(`UPDATE bluesky_targets SET status = 'publishing'
    WHERE post_id = ? AND status = 'failed'
    AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND approved_at IS NOT NULL)`).bind(id, id).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Atomic draft → publishing. False if someone else got there first. */
export function claimForPublish(db: D1Database, id: string): Promise<boolean> {
  return updatePost(db, id, { status: "publishing", error: null }, ["draft"]);
}

export async function deletePost(db: D1Database, id: string, onlyIfStatus: PostStatus[]): Promise<boolean> {
  await ensureSchema(db);
  const res = await db
    .prepare(`DELETE FROM posts WHERE id = ? AND status IN (${onlyIfStatus.map(() => "?").join(", ")})`)
    .bind(id, ...onlyIfStatus)
    .run();
  if ((res.meta.changes ?? 0) > 0) {
    await db.prepare("DELETE FROM bluesky_targets WHERE post_id = ?").bind(id).run();
    return true;
  }
  return false;
}

export async function audit(db: D1Database, actor: string, action: string, postId: string | null, detail?: string): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(`INSERT INTO audit (ts, actor, action, post_id, detail) VALUES (?, ?, ?, ?, ?)`)
    .bind(new Date().toISOString(), actor, action, postId, detail ?? null)
    .run();
}

export interface AuditRow {
  ts: string;
  actor: string;
  action: string;
  post_id: string | null;
  detail: string | null;
}

export async function recentAudit(db: D1Database, limit = 30): Promise<AuditRow[]> {
  await ensureSchema(db);
  const { results } = await db.prepare(`SELECT * FROM audit ORDER BY ts DESC LIMIT ?`).bind(limit).all<AuditRow>();
  return results;
}

// --- PIN lockout: 5 wrong PINs in an hour locks approvals for that hour.

const PIN_WINDOW_MS = 60 * 60 * 1000;
export const PIN_MAX_FAILURES = 5;

export async function pinLocked(db: D1Database): Promise<boolean> {
  await ensureSchema(db);
  const since = Date.now() - PIN_WINDOW_MS;
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM pin_failures WHERE ts > ?`).bind(since).first<{ n: number }>();
  return (r?.n ?? 0) >= PIN_MAX_FAILURES;
}

export async function recordPinFailure(db: D1Database): Promise<void> {
  await ensureSchema(db);
  await db.batch([
    db.prepare(`INSERT INTO pin_failures (ts) VALUES (?)`).bind(Date.now()),
    db.prepare(`DELETE FROM pin_failures WHERE ts < ?`).bind(Date.now() - PIN_WINDOW_MS),
  ]);
}
