/**
 * Posts, audit log and PIN attempts, in D1. D1 is strongly consistent, so the
 * draft → publishing claim below is atomic and a double-tap on Approve cannot
 * post twice.
 */

export interface BlueskyDraft {
  caption: string;
  images: Array<{ url: string; alt: string }>;
  video?: { url: string; alt: string } | null;
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
  /** Optional TikTok-specific description; falls back to the general caption. */
  tiktok_caption: string | null;
  link: string | null;
  images: string[];
  /** Null means a legacy shared gallery; [] means explicitly independent TikTok media. */
  tiktok_images: string[] | null;
  tiktok_video: string | null;
  /** Facebook video URL or private upload reference, mutually exclusive with photos. */
  video: string | null;
  scheduled_at: string | null;
  fb_post_id: string | null;
  permalink: string | null;
  note: string | null;
  error: string | null;
  created_by: string | null;
  approved_at: string | null;
  facebook_enabled: boolean;
  /** TikTok inbox-only workflow; no automatic publication. */
  tiktok_enabled?: boolean;
  bluesky: BlueskyTarget | null;
}

interface Row extends Omit<Post, "images" | "tiktok_images" | "facebook_enabled" | "tiktok_enabled" | "bluesky"> {
  facebook_enabled: number;
  tiktok_enabled: number;
  images: string;
  tiktok_images: string | null;
  bs_caption: string | null;
  bs_images: string | null;
  bs_video: string | null;
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
 b.video AS bs_video, b.patreon AS bs_patreon, b.facebook_enabled AS bs_facebook_enabled,
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
      tiktok_caption TEXT,
      link TEXT,
      images TEXT NOT NULL DEFAULT '[]',
      tiktok_images TEXT,
      tiktok_video TEXT,
      video TEXT,
      facebook_enabled INTEGER NOT NULL DEFAULT 1,
      tiktok_enabled INTEGER NOT NULL DEFAULT 0,
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
      video TEXT,
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
  // Existing deployed D1 databases predate the optional video column.
  const columns = await db.prepare("PRAGMA table_info(bluesky_targets)").all<{name:string}>();
  if (!columns.results.some(column => column.name === "video")) {
    try {
      await db.prepare("ALTER TABLE bluesky_targets ADD COLUMN video TEXT").run();
    } catch (error) {
      // A concurrent Worker may have completed the same idempotent migration.
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  const postColumns = await db.prepare("PRAGMA table_info(posts)").all<{name:string}>();
  if (!postColumns.results.some(column => column.name === "video")) {
    try { await db.prepare("ALTER TABLE posts ADD COLUMN video TEXT").run(); }
    catch(error) { if (!/duplicate column name/i.test(String(error))) throw error; }
  }
  const platformColumns=await db.prepare("PRAGMA table_info(posts)").all<{name:string}>();
  for(const [name,definition] of [["facebook_enabled","INTEGER NOT NULL DEFAULT 1"],["tiktok_enabled","INTEGER NOT NULL DEFAULT 0"],["tiktok_caption","TEXT"],["tiktok_images","TEXT"],["tiktok_video","TEXT"]]) {
    if(!platformColumns.results.some(column=>column.name===name)) {
      try {await db.prepare("ALTER TABLE posts ADD COLUMN "+name+" "+definition).run();}
      catch(error){if(!/duplicate column name/i.test(String(error)))throw error;}
    }
  }
  schemaReady = true;
}

function fromRow(r: Row): Post {
  return {
    ...r,
    images: JSON.parse(r.images || "[]"),
    tiktok_images: r.tiktok_images==null ? null : JSON.parse(r.tiktok_images),
    tiktok_video: r.tiktok_video ?? null,
    facebook_enabled: r.bs_caption === null ? r.facebook_enabled !== 0 : r.bs_facebook_enabled !== 0,
    tiktok_enabled: r.tiktok_enabled !== 0,
    bluesky: r.bs_caption === null ? null : {
      caption: r.bs_caption,
      images: JSON.parse(r.bs_images || "[]"),
      video: r.bs_video ? JSON.parse(r.bs_video) : null,
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
  tiktok_caption?: string | null;
  link?: string | null;
  images: string[];
  tiktok_images?: string[] | null;
  tiktok_video?: string | null;
  video?: string | null;
  scheduled_at: string | null;
  label?: string | null;
  release?: string | null;
  created_by: string;
  bluesky?: BlueskyDraft | null;
  facebook_enabled?: boolean;
  tiktok_enabled?: boolean;
}

export async function createPost(db: D1Database, p: NewPost): Promise<Post> {
  await ensureSchema(db);
  const now = new Date().toISOString();
  const id = newId();
  const inserts = [
    db.prepare(`INSERT INTO posts (id, created_at, updated_at, status, label, release, message, tiktok_caption, link, images, tiktok_images, tiktok_video, video, facebook_enabled, tiktok_enabled, scheduled_at, created_by)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, now, now, p.label ?? null, p.release ?? null, p.message, p.tiktok_caption ?? null, p.link ?? null, JSON.stringify(p.images),p.tiktok_images===undefined || p.tiktok_images===null ? null : JSON.stringify(p.tiktok_images),p.tiktok_video??null, p.video ?? null, p.facebook_enabled===false?0:1, p.tiktok_enabled?1:0, p.scheduled_at, p.created_by),
  ];
  if (p.bluesky) inserts.push(db.prepare(`INSERT INTO bluesky_targets
      (post_id, caption, images, video, patreon, facebook_enabled) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, p.bluesky.caption, JSON.stringify(p.bluesky.images),
      p.bluesky.video ? JSON.stringify(p.bluesky.video) : null,
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

/** Load a specific week by effective calendar time instead of the newest 200 records. */
export async function listCalendarPosts(db: D1Database, from: string, to: string): Promise<Post[]> {
  await ensureSchema(db);
  const sql = POST_SELECT + " WHERE COALESCE(p.scheduled_at, CASE WHEN p.status = 'published' THEN p.approved_at END, p.created_at) >= ?"
    + " AND COALESCE(p.scheduled_at, CASE WHEN p.status = 'published' THEN p.approved_at END, p.created_at) < ?"
    + " ORDER BY COALESCE(p.scheduled_at, p.approved_at, p.created_at) LIMIT 500";
  const { results } = await db.prepare(sql).bind(from, to).all<Row>();
  return results.map(fromRow);
}

/** Optimistic, status-guarded schedule change. Never grants approval. */
export async function updateCalendarTime(
  db: D1Database, id: string, when: string, version: string, approved: boolean, hasBluesky = false,
): Promise<boolean> {
  await ensureSchema(db);
  const now = new Date(Math.max(Date.now(), Date.parse(version) + 1)).toISOString();
  const guard = approved && hasBluesky
    ? " AND EXISTS (SELECT 1 FROM bluesky_targets WHERE post_id = ? AND status = 'scheduled')"
    : "";
  const sql = approved
    ? "UPDATE posts SET scheduled_at = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND status = 'scheduled' AND approved_at IS NOT NULL" + guard
    : "UPDATE posts SET scheduled_at = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND status IN ('draft','rejected') AND approved_at IS NULL";
  const args = approved && hasBluesky ? [when, now, id, version, id] : [when, now, id, version];
  const r = await db.prepare(sql).bind(...args).run();
  return (r.meta.changes ?? 0) === 1;
}

/** Version-guarded caption edit; Facebook and Bluesky captions update in one D1 batch. */
export async function updateCalendarCaptions(
  db: D1Database, post: Post, message: string, blueskyCaption: string | null, approved: boolean,
): Promise<boolean> {
  await ensureSchema(db);
  const nextVersion = new Date(Math.max(Date.now(), Date.parse(post.updated_at) + 1)).toISOString();
  const targetStatus = approved ? "scheduled" : "draft";
  const conditions = approved
    ? " AND status = 'scheduled' AND approved_at IS NOT NULL"
    : " AND status IN ('draft','rejected') AND approved_at IS NULL";
  const conditionForBluesky = post.bluesky
    ? " AND EXISTS (SELECT 1 FROM bluesky_targets WHERE post_id = ? AND status = ?)"
    : "";
  const args: unknown[] = [message, nextVersion, post.id, post.updated_at];
  if (post.bluesky) args.push(post.id, targetStatus);
  const statements = [
    db.prepare("UPDATE posts SET message = ?, updated_at = ? WHERE id = ? AND updated_at = ?" +
      conditions + conditionForBluesky).bind(...args),
  ];
  if (post.bluesky) {
    statements.push(db.prepare("UPDATE bluesky_targets SET caption = ? WHERE post_id = ? AND status = ?" +
      " AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND updated_at = ?)")
      .bind(blueskyCaption ?? post.bluesky.caption, post.id, targetStatus, post.id, nextVersion));
  }
  const results = await db.batch(statements);
  return (results[0].meta.changes ?? 0) === 1 &&
    (!post.bluesky || (results[1].meta.changes ?? 0) === 1);
}

/**
 * Explicitly revoke a cancelled post's prior approval and turn it back into a
 * draft. Never call this without checking that its recorded Facebook object
 * is no longer available: the old Page schedule must not be reactivated.
 *
 * A single D1 batch resets both targets. Stale forms and active/published
 * Bluesky targets cannot be reopened.
 */
export async function reopenCancelledDraft(
  db: D1Database, id: string, expectedVersion: string,
): Promise<boolean> {
  await ensureSchema(db);
  if (!Number.isFinite(Date.parse(expectedVersion))) return false;
  const now = new Date(Math.max(Date.now(), Date.parse(expectedVersion) + 1)).toISOString();
  const safeBluesky = "NOT EXISTS (SELECT 1 FROM bluesky_targets b WHERE b.post_id=posts.id AND " +
    "(b.status NOT IN ('cancelled','draft') OR b.uri IS NOT NULL OR b.cid IS NOT NULL " +
    "OR b.card_uri IS NOT NULL OR b.permalink IS NOT NULL))";
  const results = await db.batch([
    db.prepare("UPDATE posts SET status='draft', approved_at=NULL, scheduled_at=NULL, " +
      "fb_post_id=NULL, permalink=NULL, error=NULL, note=NULL, updated_at=? " +
      "WHERE id=? AND status='cancelled' AND updated_at=? AND " + safeBluesky)
      .bind(now,id,expectedVersion),
    db.prepare("UPDATE bluesky_targets SET status='draft', error=NULL, uri=NULL, cid=NULL, " +
      "card_uri=NULL, permalink=NULL, started_at=NULL WHERE post_id=? " +
      "AND status IN ('cancelled','draft') AND uri IS NULL AND cid IS NULL " +
      "AND card_uri IS NULL AND permalink IS NULL " +
      "AND EXISTS (SELECT 1 FROM posts WHERE id=? AND status='draft' AND updated_at=? AND approved_at IS NULL)")
      .bind(id,id,now),
  ]);
  return (results[0].meta.changes ?? 0)===1;
}

/** Store one video for either or both targets in a draft-only D1 transaction. */
/** Distinguish new independent TikTok galleries from legacy shared media records. */
export function tiktokMedia(post:Post):{images:string[];video:string|null} {
  return post.tiktok_images==null
    ? {images:post.images,video:post.video}
    : {images:post.tiktok_images,video:post.tiktok_video};
}

/** Attach video only to explicitly selected targets, without modifying other platforms. */
export async function attachDraftVideo(
  db:D1Database,id:string,reference:string,alt:string,
  facebook:boolean,bluesky:boolean,expectedVersion:string,tiktok=false,
):Promise<string|null> {
  await ensureSchema(db);
  if(!facebook&&!bluesky&&!tiktok)throw Error("Select at least one platform.");
  if(bluesky&&!alt.trim())throw Error("Bluesky video requires alternative text.");
  const version=new Date(Math.max(Date.now(),Date.parse(expectedVersion)+1)).toISOString();
  const blueGuard=bluesky?" AND EXISTS(SELECT 1 FROM bluesky_targets b WHERE b.post_id=posts.id AND b.status='draft' AND json_array_length(b.images)=0)":"";
  const update=db.prepare(
    "UPDATE posts SET video=CASE WHEN ? OR (? AND tiktok_images IS NULL) THEN ? ELSE video END, "+
    "tiktok_video=CASE WHEN ? AND tiktok_images IS NOT NULL THEN ? ELSE tiktok_video END, updated_at=? "+
    "WHERE id=? AND updated_at=? AND approved_at IS NULL AND status IN ('draft','rejected') "+
    (facebook?" AND facebook_enabled=1 AND json_array_length(images)=0":"")+
    (tiktok?" AND tiktok_enabled=1 AND ((tiktok_images IS NULL AND json_array_length(images)=0) OR "+
      "(tiktok_images IS NOT NULL AND json_array_length(tiktok_images)=0))":"")+
    blueGuard
  ).bind(facebook?1:0,tiktok?1:0,reference,tiktok?1:0,reference,version,id,expectedVersion);
  const mutations=[update];
  if(bluesky)mutations.push(db.prepare(
    "UPDATE bluesky_targets SET video=json_object('url',?,'alt',?) WHERE post_id=? "+
    "AND status='draft' AND json_array_length(images)=0 "+
    "AND EXISTS(SELECT 1 FROM posts WHERE id=? AND updated_at=? AND approved_at IS NULL)"
  ).bind(reference,alt.trim(),id,id,version));
  const result=await db.batch(mutations);
  return result[0].meta.changes===1&&(!bluesky||result[1].meta.changes===1)?version:null;
}

/** Append a photo only to each selected platform's gallery, preserving order. */
export async function attachDraftImage(
  db:D1Database,id:string,reference:string,alt:string,
  facebook:boolean,bluesky:boolean,expectedVersion:string,tiktok=false,
):Promise<string|null> {
  await ensureSchema(db);
  if(!facebook&&!bluesky&&!tiktok)throw Error("Select at least one platform.");
  if(bluesky&&!alt.trim())throw Error("Alternative text is required for Bluesky.");
  const next=new Date(Math.max(Date.now(),Date.parse(expectedVersion)+1)).toISOString();
  const blueGuard=bluesky?" AND EXISTS(SELECT 1 FROM bluesky_targets b WHERE b.post_id=posts.id AND b.status='draft' AND b.video IS NULL AND json_array_length(b.images)<4)":"";
  const mainGuard=facebook?" AND facebook_enabled=1 AND video IS NULL AND json_array_length(images)<80":"";
  const ttGuard=tiktok?" AND tiktok_enabled=1 AND ((tiktok_images IS NULL AND video IS NULL AND json_array_length(images)<35) "+
    "OR (tiktok_images IS NOT NULL AND tiktok_video IS NULL AND json_array_length(tiktok_images)<35))":"";
  const postUpdate=db.prepare(
    "UPDATE posts SET images=CASE WHEN ? OR (? AND tiktok_images IS NULL) THEN json_insert(images,'$[#]',?) ELSE images END, "+
    "tiktok_images=CASE WHEN ? AND tiktok_images IS NOT NULL THEN json_insert(tiktok_images,'$[#]',?) ELSE tiktok_images END, updated_at=? "+
    "WHERE id=? AND updated_at=? AND status IN ('draft','rejected') AND approved_at IS NULL "+
    mainGuard+ttGuard+blueGuard+
    ((!facebook&&!tiktok)?" AND EXISTS (SELECT 1 FROM bluesky_targets WHERE post_id=posts.id AND status='draft')":"")
  ).bind(facebook?1:0,tiktok?1:0,reference,tiktok?1:0,reference,next,id,expectedVersion);
  const mutations=[postUpdate];
  if(bluesky)mutations.push(db.prepare(
    "UPDATE bluesky_targets SET images=json_insert(images,'$[#]',json_object('url',?, 'alt',?)) "+
    "WHERE post_id=? AND status='draft' AND video IS NULL AND json_array_length(images)<4 "+
    "AND EXISTS(SELECT 1 FROM posts WHERE id=? AND updated_at=? AND approved_at IS NULL)"
  ).bind(reference,alt.trim(),id,id,next));
  const result=await db.batch(mutations);
  return result[0].meta.changes===1&&(!bluesky||result[1].meta.changes===1)?next:null;
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
  const result = await db.prepare(`INSERT INTO bluesky_targets (post_id, caption, images, video, patreon, facebook_enabled)
    SELECT ?, ?, ?, ?, ?, ? FROM posts WHERE id = ? AND status IN ('draft','rejected')
    ON CONFLICT(post_id) DO UPDATE SET
      caption = excluded.caption, images = excluded.images, video = excluded.video,
      patreon = excluded.patreon, facebook_enabled = excluded.facebook_enabled,
      status = 'draft', uri = NULL, cid = NULL, card_uri = NULL, permalink = NULL, error = NULL
    WHERE EXISTS (SELECT 1 FROM posts WHERE id = ? AND status IN ('draft','rejected'))`)
    .bind(id, draft.caption, JSON.stringify(draft.images),
      draft.video ? JSON.stringify(draft.video) : null,
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
      AND scheduled_at IS NOT NULL AND scheduled_at <= ? AND status IN ('publishing','scheduled','published','failed'))`)
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
      AND p.status IN ('publishing','scheduled','published','failed')
    ORDER BY p.scheduled_at LIMIT 20`).bind(stale, now).all<{ id: string }>();
  return result.results.map((r) => r.id);
}

export async function claimFailedBluesky(db: D1Database, id: string): Promise<boolean> {
  await ensureSchema(db);
  const result = await db.prepare(`UPDATE bluesky_targets SET status = 'publishing', started_at = ?
    WHERE post_id = ? AND status = 'failed'
    AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND approved_at IS NOT NULL)`)
    .bind(new Date().toISOString(), id, id).run();
  return (result.meta.changes ?? 0) > 0;
}

export interface ApprovalSnapshot {
  message: string;
  scheduledAt: Date | null;
  facebookEnabled: boolean;
  bluesky: BlueskyDraft | null;
  expectedUpdatedAt: string;
}

/** Save the exact human-selected targets and claim the draft in one transaction. */
export async function claimForPublish(db: D1Database, id: string, input: ApprovalSnapshot): Promise<boolean> {
  await ensureSchema(db);
  if (!input.facebookEnabled && !input.bluesky) throw new Error("Choose at least one target.");
  const { bluesky } = input;
  const target = bluesky
    ? db.prepare(`INSERT INTO bluesky_targets (post_id, caption, images, video, patreon, facebook_enabled)
        SELECT ?, ?, ?, ?, ?, ? FROM posts WHERE id = ? AND status = 'draft' AND updated_at = ?
        ON CONFLICT(post_id) DO UPDATE SET
          caption = excluded.caption, images = excluded.images, video = excluded.video, patreon = excluded.patreon,
          facebook_enabled = excluded.facebook_enabled, status = 'draft',
          uri = NULL, cid = NULL, card_uri = NULL, permalink = NULL, error = NULL, started_at = NULL`)
      .bind(id, bluesky.caption, JSON.stringify(bluesky.images),
        bluesky.video ? JSON.stringify(bluesky.video) : null,
        bluesky.patreon ? JSON.stringify(bluesky.patreon) : null, input.facebookEnabled ? 1 : 0,
        id, input.expectedUpdatedAt)
    : db.prepare(`DELETE FROM bluesky_targets WHERE post_id = ?
        AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND status = 'draft' AND updated_at = ?)`)
      .bind(id, id, input.expectedUpdatedAt);
  const now = new Date().toISOString();
  // D1 batch is transactional. Concurrent requests cannot write different targets
  // between this target change and the draft-to-publishing claim. The losing
  // transaction sees a non-draft and both of its statements make no changes.
  const results = await db.batch([
    target,
    db.prepare(`UPDATE posts SET message = ?, scheduled_at = ?, status = 'publishing',
        approved_at = ?, error = NULL, updated_at = ?
        WHERE id = ? AND status = 'draft' AND updated_at = ?`)
      .bind(input.message, input.scheduledAt?.toISOString() ?? null, now, now, id, input.expectedUpdatedAt),
  ]);
  return (results[1].meta.changes ?? 0) === 1;
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
