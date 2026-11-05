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

export async function searchPosts(
  db: D1Database, section: PostSection, search = "", requestedPage = 1,
): Promise<Paged<Post>> {
  await ensureSchema(db);
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
  const rows = await db.prepare(POST_SELECT + where + order + " LIMIT ? OFFSET ?")
    .bind(...binds, PAGE_SIZE, (page - 1) * PAGE_SIZE).all<Row>();
  return { items: rows.results.map(fromRow), total, page, pages };
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

const transferActive = "('transferring','processing','transfer_complete'," +
  "'inbox_ready','needs_review','published_by_creator')";

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
    " updated_at=? WHERE status='draft' AND approved_at IS NULL AND tiktok_enabled=1 AND facebook_enabled=0" +
    " AND NOT EXISTS (SELECT 1 FROM bluesky_targets b WHERE b.post_id=posts.id AND b.status<>'disabled')" +
    " AND NOT EXISTS (SELECT 1 FROM instagram_targets i WHERE i.post_id=posts.id AND i.status<>'disabled')" +
    " AND EXISTS (SELECT 1 FROM tiktok_inbox_transfers t WHERE t.post_id=posts.id AND t.status IN " + transferActive + ")")
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
    " WHERE id=? AND updated_at=? AND status='draft' AND approved_at IS NULL AND tiktok_enabled=1" +
    " AND EXISTS (SELECT 1 FROM tiktok_inbox_transfers t WHERE t.post_id=posts.id AND t.status IN " + transferActive + ")")
    .bind(now, postId, expectedVersion).run();
  return (result.meta.changes ?? 0) === 1;
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
    " AND tiktok_enabled=1 AND fb_post_id IS NULL" +
    " AND NOT EXISTS (SELECT 1 FROM bluesky_targets b WHERE b.post_id=posts.id" +
    " AND b.status IN ('scheduled','publishing','published'))" +
    " AND NOT EXISTS (SELECT 1 FROM instagram_jobs i WHERE i.post_id=posts.id" +
    " AND i.status IN ('scheduled','preparing','processing','sending','failed'))" +
    " AND EXISTS (SELECT 1 FROM tiktok_inbox_transfers t WHERE t.post_id=posts.id" +
    " AND t.status='published_by_creator')")
    .bind(now,postId).run();
  return (result.meta.changes ?? 0) === 1;
}
