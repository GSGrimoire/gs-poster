/** Private one-time, non-public R2 uploads. Uploading never publishes a post. */
import type { Env } from "./env.ts";
import { randomToken, safeEqual, sha256 } from "./session.ts";

export const UPLOAD_RETENTION_DAYS = 45;
export const UPLOAD_PUT_WINDOW_MS = 10 * 60 * 1000;
export const UPLOAD_MAX_LINKS_PER_HOUR = 60;
export const UPLOAD_QUOTA_BYTES = 3 * 1024 * 1024 * 1024;
// Allow two days for the 45-day R2 lifecycle deletion to complete.
export const UPLOAD_ACCOUNTING_DAYS = UPLOAD_RETENTION_DAYS + 2;

export type UploadExt = "jpg" | "jpeg" | "png" | "gif" | "mp4";
export interface UploadRef { id: string; ext: UploadExt }
const TYPES: Record<UploadExt, { mime: string; max: number }> = {
  jpg: { mime: "image/jpeg", max: 10 * 1024 * 1024 },
  jpeg: { mime: "image/jpeg", max: 10 * 1024 * 1024 },
  png: { mime: "image/png", max: 10 * 1024 * 1024 },
  gif: { mime: "image/gif", max: 10 * 1024 * 1024 },
  mp4: { mime: "video/mp4", max: 20_000_000 },
};
const REF = /^upload:\/\/([a-f0-9]{32})\.(jpg|jpeg|png|gif|mp4)$/;
const key = (r: UploadRef) => "uploads/" + r.id + "." + r.ext;
export const isUploadRef = (s: string): boolean => s.startsWith("upload://");
export function parseUploadRef(s: string): UploadRef | null {
  const m = REF.exec(s);
  return m ? { id: m[1], ext: m[2] as UploadExt } : null;
}
export const formatUploadRef = (r: UploadRef): string => "upload://" + r.id + "." + r.ext;
export function extensionOf(filename: string): UploadExt | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return Object.prototype.hasOwnProperty.call(TYPES, ext) ? ext as UploadExt : null;
}
const ascii = (b: Uint8Array, i: number, j: number): string =>
  String.fromCharCode(...b.subarray(i, j));
export function looksLike(ext: UploadExt, bytes: Uint8Array): boolean {
  if (ext === "jpg" || ext === "jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (ext === "png") return [137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v);
  if (ext === "gif") return ascii(bytes,0,4) === "GIF8" && (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97;
  return ascii(bytes,4,8) === "ftyp";
}
interface UploadRow {
  id: string; token_hash: string; ext: UploadExt; max_bytes: number;
  status: "pending" | "uploading" | "stored"; created_at: string;
  expires_at: string; bytes: number | null; created_by: string | null;
}
let schemaReady = false;
async function ensureUploads(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, ext TEXT NOT NULL, max_bytes INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, expires_at TEXT NOT NULL, bytes INTEGER, created_by TEXT)"),
    db.prepare("CREATE INDEX IF NOT EXISTS uploads_created ON uploads(created_at)"),
  ]);
  schemaReady = true;
}
export interface UploadGrant {
  reference: string; upload_url: string; method: "PUT"; expires_at: string;
  max_bytes: number; keep_days: number; curl: string;
}
export interface UploadUsage {
  estimated_stored_bytes: number;
  reserved_bytes: number;
  remaining_bytes: number;
  quota_bytes: number;
  percent_reserved: number;
  links_last_hour: number;
  max_links_per_hour: number;
  retention_days: number;
  accounting_days: number;
  note: string;
}

/** Counts this Worker's uploads, not Cloudflare's account-level billable usage. */
export async function getUploadUsage(db: D1Database, at = new Date()): Promise<UploadUsage> {
  await ensureUploads(db);
  const now = at.toISOString();
  const since = new Date(at.getTime() - UPLOAD_ACCOUNTING_DAYS * 86400_000).toISOString();
  const hourAgo = new Date(at.getTime() - 3600_000).toISOString();
  const { results } = await db.prepare(
    "SELECT status, max_bytes, bytes, expires_at, created_at FROM uploads WHERE created_at > ?",
  ).bind(since).all<Pick<UploadRow,"status" | "max_bytes" | "bytes" | "expires_at" | "created_at">>();
  const stored = results.reduce((sum,r) =>
    sum + (r.status === "stored" ? (r.bytes ?? r.max_bytes) : 0), 0);
  const reserved = results.reduce((sum,r) => sum +
    (r.status === "stored" ? (r.bytes ?? r.max_bytes) :
      r.status === "uploading" ? r.max_bytes :
      r.status === "pending" && r.expires_at > now ? r.max_bytes : 0), 0);
  return {
    estimated_stored_bytes: stored,
    reserved_bytes: reserved,
    remaining_bytes: Math.max(0, UPLOAD_QUOTA_BYTES - reserved),
    quota_bytes: UPLOAD_QUOTA_BYTES,
    percent_reserved: Math.round((reserved / UPLOAD_QUOTA_BYTES) * 10000) / 100,
    links_last_hour: results.filter(r => r.created_at > hourAgo).length,
    max_links_per_hour: UPLOAD_MAX_LINKS_PER_HOUR,
    retention_days: UPLOAD_RETENTION_DAYS,
    accounting_days: UPLOAD_ACCOUNTING_DAYS,
    note: "Estimated GS Poster upload reservations only. Cloudflare's Billable Usage dashboard is authoritative for account-wide storage and operation charges.",
  };
}

export async function createUpload(env: Env, origin: string, input: { filename: string; actor: string }): Promise<UploadGrant> {
  if (!env.UPLOADS) throw new Error("File uploads are not set up on this server (UPLOADS binding missing).");
  const ext = extensionOf(input.filename);
  if (!ext) throw new Error("Unsupported file type. Use JPG, PNG, GIF or MP4.");
  const now = new Date();
  const nowIso = now.toISOString();
  const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
  const keepSince = new Date(now.getTime() - UPLOAD_ACCOUNTING_DAYS * 86400_000).toISOString();
  const usage = await getUploadUsage(env.DB, now);
  if (usage.links_last_hour >= UPLOAD_MAX_LINKS_PER_HOUR)
    throw new Error("Too many upload links were requested in the last hour.");
  const max = TYPES[ext].max;
  if (usage.reserved_bytes + max > UPLOAD_QUOTA_BYTES)
    throw new Error("Upload storage is full.");
  const id = [...crypto.getRandomValues(new Uint8Array(16))]
    .map(v => v.toString(16).padStart(2,"0")).join("");
  const token = randomToken();
  const expires = new Date(now.getTime() + UPLOAD_PUT_WINDOW_MS).toISOString();

  // Check and reserve in ONE SQLite write. Concurrent requests cannot
  // allocate above the space budget or rate limit.
  const grant = await env.DB.prepare(`INSERT INTO uploads
    (id, token_hash, ext, max_bytes, status, created_at, expires_at, created_by)
    SELECT ?, ?, ?, ?, 'pending', ?, ?, ?
    WHERE
      (SELECT COALESCE(SUM(
        CASE WHEN status = 'stored' THEN COALESCE(bytes,max_bytes)
          WHEN status = 'uploading' THEN max_bytes
          WHEN status = 'pending' AND expires_at > ? THEN max_bytes
          ELSE 0 END),0)
       FROM uploads WHERE created_at > ?) + ? <= ?
      AND (SELECT COUNT(*) FROM uploads WHERE created_at > ?) < ?`)
    .bind(id, await sha256(token), ext, max, nowIso, expires, input.actor,
      nowIso, keepSince, max, UPLOAD_QUOTA_BYTES,
      hourAgo, UPLOAD_MAX_LINKS_PER_HOUR).run();
  if ((grant.meta.changes ?? 0) !== 1) {
    throw new Error("Upload budget exceeded by concurrent requests. No upload link was created.");
  }

  // Retain accounting records slightly longer than R2's 45-day lifetime.
  const forgetBefore = new Date(now.getTime() - (UPLOAD_ACCOUNTING_DAYS + 30) * 86400_000).toISOString();
  await env.DB.prepare("DELETE FROM uploads WHERE created_at < ?").bind(forgetBefore).run();
  const url = origin + "/upload/" + id + "/" + token;
  return {
    reference: formatUploadRef({id,ext}), upload_url: url, method: "PUT",
    expires_at: expires, max_bytes: max, keep_days: UPLOAD_RETENTION_DAYS,
    curl: 'curl -sS --fail-with-body -T "<path-to-file>" "' + url + '"',
  };
}

class UploadError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  } });
}
/** PUT /upload/:id/:token is the only unauthenticated write. */
export async function handleUploadPut(request: Request, env: Env): Promise<Response> {
  const match = /^\/upload\/([a-f0-9]{32})\/([A-Za-z0-9_-]{20,64})$/.exec(new URL(request.url).pathname);
  if (!match) return json({error:"Not found."},404);
  if (request.method !== "PUT") return new Response(JSON.stringify({error:"Use PUT."}),{
    status:405, headers:{"Allow":"PUT","Content-Type":"application/json","Cache-Control":"no-store"}
  });
  if (!env.UPLOADS) return json({error:"Uploads are not set up."},503);
  await ensureUploads(env.DB);
  const [ , id, token ] = match;
  const gone = () => json({error:"This upload link is unknown, expired or already used."},404);
  const row = await env.DB.prepare("SELECT * FROM uploads WHERE id = ?").bind(id).first<UploadRow>();
  if (!row || row.status !== "pending" || row.expires_at <= new Date().toISOString() ||
      !safeEqual(await sha256(token),row.token_hash)) return gone();
  const lengthHeader = request.headers.get("content-length");
  const length = lengthHeader === null ? NaN : Number(lengthHeader);
  if (!Number.isSafeInteger(length) || length <= 0) return json({error:"Content-Length is required."},411);
  if (length > row.max_bytes) return json({error:"File exceeds allowed size."},413);
  const claim = await env.DB.prepare("UPDATE uploads SET status = 'uploading' WHERE id = ? AND status = 'pending' AND expires_at > ?")
    .bind(id,new Date().toISOString()).run();
  if ((claim.meta.changes ?? 0) !== 1) return gone();
  let writeStarted = false;
  try {
    const body = await request.arrayBuffer();
    if (!body.byteLength) throw new UploadError("The file is empty.",400);
    if (body.byteLength > row.max_bytes || body.byteLength !== length)
      throw new UploadError("Content size is invalid.",413);
    if (!looksLike(row.ext,new Uint8Array(body,0,Math.min(16,body.byteLength))))
      throw new UploadError("File header does not match its extension.",415);
    const ref = {id, ext:row.ext};
    // Once R2 is called, a network failure may be ambiguous: never reuse the token.
    writeStarted = true;
    await env.UPLOADS.put(key(ref),body,{httpMetadata:{contentType:TYPES[row.ext].mime}});
    const mark = await env.DB.prepare("UPDATE uploads SET status = 'stored', bytes = ? WHERE id = ? AND status = 'uploading'")
      .bind(body.byteLength,id).run();
    if ((mark.meta.changes ?? 0) !== 1) throw new Error("Failed to finalize the upload record.");
    return json({ok:true,reference:formatUploadRef(ref),bytes:body.byteLength});
  } catch (error) {
    // Do not reopen a token after a successful R2 write: a retry could overwrite its object.
    if (!writeStarted) await env.DB.prepare("UPDATE uploads SET status = 'pending' WHERE id = ? AND status = 'uploading'")
      .bind(id).run();
    return error instanceof UploadError
      ? json({error:error.message},error.status)
      : json({error:"Upload failed. Contact support if the link has been consumed."},500);
  }
}
/** Verify that a browser upload finished and belongs to the signed-in owner. */
export async function isStoredOwnerUpload(db: D1Database, reference: string, login: string): Promise<boolean> {
  const ref = parseUploadRef(reference);
  if (!ref) return false;
  await ensureUploads(db);
  const row = await db.prepare(
    "SELECT status, ext, created_by FROM uploads WHERE id = ?"
  ).bind(ref.id).first<Pick<UploadRow, "status" | "ext" | "created_by">>();
  return !!row && row.status === "stored" && row.ext === ref.ext &&
    row.created_by?.toLowerCase() === login.toLowerCase() && ref.ext !== "mp4";
}

/** Raw private object access for internal preflight, review preview and approved publication. */
export async function readUpload(env: Env, ref: UploadRef): Promise<ArrayBuffer> {
  if (!env.UPLOADS) throw new Error("File uploads are not set up on this server.");
  const object = await env.UPLOADS.get(key(ref));
  if (!object) throw new Error("Upload " + formatUploadRef(ref) + " was not found or has expired.");
  return object.arrayBuffer();
}
