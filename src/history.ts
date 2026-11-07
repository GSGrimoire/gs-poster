/**
 * Read-only, database-backed dashboard history and a tightly scoped TikTok
 * status reconciliation. A TikTok inbox transfer is NOT a scheduled publish.
 */
import type { D1Database } from "@cloudflare/workers-types";
import {
  ensureSchema, POST_SELECT, fromRow, type Row, type Post, type AuditRow,
} from "./db.ts";
import { ensureTikTokInboxSchema } from "./tiktok-inbox.ts";

export const PAGE_SIZE = 20;
export type PostSection = "drafts" | "scheduled" | "published" | "other";
export type TikTokHistoryState = "inbox" | "published" | null;
export type HistoryPost = Post & { tiktokHistoryState: TikTokHistoryState };

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pages: number;
}
const STATUS_WHERE: Record<PostSection, string> = {
  drafts: "p.status IN ('draft','rejected')",
  scheduled: "p.status IN ('scheduled','publishing')",
  published: "p.status = 'published'",
  other: "p.status IN ('failed','cancelled')",
};

const pageNum = (n: number) => Number.isSafeInteger(n) && n > 0 ? Math.min(n, 100_000) : 1;
export const normalizedSearch = (s: string) => s.trim().slice(0, 120);
const pattern = (s: string) => "%" + normalizedSearch(s).toLowerCase()
  .replace(/[\\%_]/g, (char) => "\\" + char) + "%";
const postFields = [
  "p.id", "p.label", "p.release", "p.message", "p.tiktok_caption",
  "p.tiktok_title", "b.caption", "i.caption",
];
const escLike = " ESCAPE '\\'";
const postSearch = "(" + postFields.map((x) =>
  "LOWER(COALESCE(" + x + ",'')) LIKE ?" + escLike).join(" OR ") + ")";
const auditSearch = "(" + ["actor", "action", "post_id", "detail"].map((x) =>
  "LOWER(COALESCE(" + x + ",'')) LIKE ?" + escLike).join(" OR ") + ")";

// Keep transitions and display on the same definition of a TikTok-only
// record. A prepared sibling target counts even before it has a delivery job.
const tiktokOnly = (post: "posts" | "p") => `
  ${post}.tiktok_enabled=1 AND ${post}.facebook_enabled=0 AND ${post}.fb_post_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM bluesky_targets b WHERE b.post_id=${post}.id AND b.status<>'disabled')
  AND NOT EXISTS (SELECT 1 FROM instagram_targets i WHERE i.post_id=${post}.id AND i.status<>'disabled')
  AND NOT EXISTS (SELECT 1 FROM instagram_jobs j WHERE j.post_id=${post}.id AND j.status<>'cancelled')`;
const transferExists = (post: "posts" | "p", condition = "") =>
  `EXISTS (SELECT 1 FROM tiktok_inbox_transfers t WHERE t.post_id=${post}.id ${condition})`;
const creatorConfirmed = "AND t.status='published_by_creator'";
const historyState = `CASE WHEN p.approved_at IS NOT NULL AND p.scheduled_at IS NULL
    AND ${tiktokOnly("p")} THEN
  CASE WHEN p.status='scheduled' AND ${transferExists("p")} THEN 'inbox'
       WHEN p.status='published' AND ${transferExists("p", creatorConfirmed)} THEN 'published'
  END END AS tiktok_history_state`;

export async function getTikTokHistoryState(db: D1Database, postId: string): Promise<TikTokHistoryState> {
  await ensureSchema(db);
  await ensureTikTokInboxSchema(db);
  const row = await db.prepare(`SELECT ${historyState} FROM posts p WHERE p.id=?`)
    .bind(postId).first<{ tiktok_history_state: TikTokHistoryState }>();
  return row?.tiktok_history_state ?? null;
}

export async function searchPosts(
  db: D1Database, section: PostSection, search = "", requestedPage = 1,
): Promise<Paged<HistoryPost>> {
  await ensureSchema(db);
  await ensureTikTokInboxSchema(db);
  const joins = " FROM posts p LEFT JOIN bluesky_targets b ON p.id=b.post_id" +
    " LEFT JOIN instagram_targets i ON p.id=i.post_id";
  const where = " WHERE " + STATUS_WHERE[section] + " AND " + postSearch;
  const binds = postFields.map(() => pattern(search));
  const n = await db.prepare("SELECT COUNT(*) AS total" + joins + where)
    .bind(...binds).first<{ total: number }>();
  const total = n?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pageNum(requestedPage), pages);
  const order = section === "scheduled"
    ? " ORDER BY COALESCE(p.scheduled_at,p.approved_at,p.created_at) DESC,p.id DESC"
    : " ORDER BY p.updated_at DESC,p.id DESC";
  const rows = await db.prepare(POST_SELECT.replace("SELECT p.*,", `SELECT p.*, ${historyState},`) + where + order + " LIMIT ? OFFSET ?")
    .bind(...binds, PAGE_SIZE, (page - 1) * PAGE_SIZE).all<Row & { tiktok_history_state: TikTokHistoryState }>();
  return { items: rows.results.map(row => ({ ...fromRow(row), tiktokHistoryState: row.tiktok_history_state })), total, page, pages };
}

export async function searchActivity(
  db: D1Database, search = "", requestedPage = 1,
): Promise<Paged<AuditRow>> {
  await ensureSchema(db);
  const binds = Array(4).fill(pattern(search)) as string[];
  const where = " WHERE " + auditSearch;
  const n = await db.prepare("SELECT COUNT(*) AS total FROM audit" + where)
    .bind(...binds).first<{ total: number }>();
  const total = n?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pageNum(requestedPage), pages);
  const rows = await db.prepare("SELECT * FROM audit" + where +
    " ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?")
    .bind(...binds, PAGE_SIZE, (page - 1) * PAGE_SIZE).all<AuditRow>();
  return { items: rows.results, total, page, pages };
}

// An in-flight claim can still end in a definitive refusal. Leave it in
// Drafts until the attempt records a result. A claim also cannot approve a
// newer edit, including when the legacy reconciliation runs on page load.
const transferRecorded = "AND t.status IN ('processing','transfer_complete','inbox_ready','needs_review','published_by_creator')";
const matchingVersion = "AND t.post_version=posts.updated_at";
const legacyVersion = `AND (t.post_version=posts.updated_at OR
  (t.post_version IS NULL AND posts.created_at=posts.updated_at AND t.created_at>=posts.updated_at))`;
const recoveryOutcome = `AND (t.status IN ('rejected','cleared')
  OR (t.status='failed' AND t.remote_status='FAILED'))`;

/**
 * Idempotent recovery for existing, unambiguously TikTok-only inbox attempts
 * left in Drafts by the old application. Does not contact TikTok, automatically
 * retry, change mixed-target approvals, or touch rejected/cleared transfers.
 */
export async function reconcileOldTikTokInboxDrafts(db: D1Database): Promise<number> {
  await ensureSchema(db);
  await ensureTikTokInboxSchema(db);
  const now = new Date().toISOString();
  const result = await db.prepare("UPDATE posts SET status='scheduled'," +
    " scheduled_at=NULL, approved_at=(SELECT t.created_at FROM tiktok_inbox_transfers t WHERE t.post_id=posts.id)," +
    " updated_at=? WHERE status='draft' AND approved_at IS NULL" +
    ` AND ${tiktokOnly("posts")} AND ${transferExists("posts", transferRecorded + " " + legacyVersion)}`)
    .bind(now).run();
  return result.meta.changes ?? 0;
}

/**
 * The caller must have already authenticated the owner, verified their PIN,
 * confirmed TikTok as the only chosen release target, and attempted one
 * version-fenced TikTok transfer. This only changes local classification after
 * a durable transfer claim, including uncertain sends that must be reconciled.
 * Never claims TikTok has actually published anything.
 */
export async function markTikTokInboxApproved(
  db: D1Database, postId: string, expectedVersion: string,
): Promise<boolean> {
  await ensureSchema(db);
  await ensureTikTokInboxSchema(db);
  if (!Number.isFinite(Date.parse(expectedVersion))) return false;
  const now = new Date(Math.max(Date.now(), Date.parse(expectedVersion) + 1)).toISOString();
  const result = await db.prepare("UPDATE posts SET status='scheduled', scheduled_at=NULL," +
    " approved_at=(SELECT t.created_at FROM tiktok_inbox_transfers t WHERE t.post_id=posts.id), updated_at=?" +
    " WHERE id=? AND updated_at=? AND status='draft' AND approved_at IS NULL" +
    ` AND ${tiktokOnly("posts")} AND ${transferExists("posts", transferRecorded + " " + matchingVersion)}`)
    .bind(now, postId, expectedVersion).run();
  return (result.meta.changes ?? 0) === 1;
}


export async function reopenTikTokInboxDraft(
  db: D1Database, postId: string, expectedVersion: string,
): Promise<boolean> {
  await ensureSchema(db);
  await ensureTikTokInboxSchema(db);
  if (!Number.isFinite(Date.parse(expectedVersion))) return false;
  const now = new Date(Math.max(Date.now(), Date.parse(expectedVersion) + 1)).toISOString();
  const result = await db.prepare(`UPDATE posts SET status='draft', approved_at=NULL, updated_at=?
    WHERE id=? AND updated_at=? AND status='scheduled' AND approved_at IS NOT NULL AND scheduled_at IS NULL
      AND ${tiktokOnly("posts")} AND ${transferExists("posts", recoveryOutcome)}`)
    .bind(now, postId, expectedVersion).run();
  return result.meta.changes === 1;
}

/** Only a confirmed TikTok status check can move an inbox-only record to
 * Published. No provider request occurs here, and mixed Facebook, Bluesky or
 * Instagram jobs remain governed by their own independent delivery states. */
export async function markTikTokCreatorPublished(db: D1Database,postId: string): Promise<boolean> {
  await ensureSchema(db);
  await ensureTikTokInboxSchema(db);
  const now = new Date().toISOString();
  const result = await db.prepare("UPDATE posts SET status='published', updated_at=?" +
    " WHERE id=? AND status='scheduled' AND approved_at IS NOT NULL AND scheduled_at IS NULL" +
    ` AND ${tiktokOnly("posts")} AND ${transferExists("posts", creatorConfirmed)}`)
    .bind(now,postId).run();
  return (result.meta.changes ?? 0) === 1;
}
