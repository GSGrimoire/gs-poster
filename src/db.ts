/**
 * Posts, audit log and PIN attempts, in D1. D1 is strongly consistent, so the
 * draft → publishing claim below is atomic and a double-tap on Approve cannot
 * post twice.
 */

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
}

interface Row extends Omit<Post, "images"> {
  images: string;
}

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
  ]);
  schemaReady = true;
}

function fromRow(r: Row): Post {
  return { ...r, images: JSON.parse(r.images || "[]") };
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
}

export async function createPost(db: D1Database, p: NewPost): Promise<Post> {
  await ensureSchema(db);
  const now = new Date().toISOString();
  const id = newId();
  await db
    .prepare(
      `INSERT INTO posts (id, created_at, updated_at, status, label, release, message, link, images, scheduled_at, created_by)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, now, now, p.label ?? null, p.release ?? null, p.message, p.link ?? null, JSON.stringify(p.images), p.scheduled_at, p.created_by)
    .run();
  return (await getPost(db, id))!;
}

export async function getPost(db: D1Database, id: string): Promise<Post | null> {
  await ensureSchema(db);
  const r = await db.prepare(`SELECT * FROM posts WHERE id = ?`).bind(id).first<Row>();
  return r ? fromRow(r) : null;
}

export async function listPosts(db: D1Database, opts: { status?: PostStatus; limit?: number } = {}): Promise<Post[]> {
  await ensureSchema(db);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const stmt = opts.status
    ? db.prepare(`SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC LIMIT ?`).bind(opts.status, limit)
    : db.prepare(`SELECT * FROM posts ORDER BY created_at DESC LIMIT ?`).bind(limit);
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
  return (res.meta.changes ?? 0) > 0;
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
