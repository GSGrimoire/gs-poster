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
  mp4: { mime: "video/mp4", max: 50_000_000 },
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
  status: "pending" | "uploading" | "stored" | "failed"; created_at: string;
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
/** Carries whether the multipart path conclusively never committed an object.
 * An abort failure or a possibly completed upload MUST retain its quota fence. */
class MultipartStoreFailure extends Error {
  constructor(readonly original:unknown,readonly definitelyAbsent:boolean) {
    super(original instanceof Error ? original.message : String(original));
  }
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  } });
}
/** A chunk-sized SHA-256 fence, so verification never retains an entire MP4. */
export interface UploadPartDigest { bytes: number; sha256: string }
const VIDEO_PART_BYTES = 5 * 1024 * 1024;
async function digestPart(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, n => n.toString(16).padStart(2, "0")).join("");
}

/** Read back completed multipart media in bounded ranges before making it draft-ready. */
export async function verifyStoredUploadParts(
  env: Env, ref: UploadRef, parts: UploadPartDigest[],
): Promise<void> {
  if (!env.UPLOADS || !parts.length) throw new Error("Private upload verification is unavailable.");
  let offset = 0;
  for (const part of parts) {
    if (!part.bytes || part.bytes > VIDEO_PART_BYTES) throw new Error("Invalid private media part.");
    const object = await env.UPLOADS.get(key(ref), {range:{offset,length:part.bytes}});
    if (!object || !("body" in object)) throw new Error("Private video readback was not confirmed.");
    // Each range is at most 5 MiB. Never readUpload() the whole 50 MB file here.
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== part.bytes || await digestPart(bytes) !== part.sha256)
      throw new Error("Private video copy failed the integrity check.");
    offset += part.bytes;
  }
  const head = await env.UPLOADS.head(key(ref));
  if (!head || head.size !== offset) throw new Error("Private video size could not be confirmed.");
}

/** Bound the ACTUAL incoming bytes before allocating the image buffer. */
async function boundedImageBody(
  source: ReadableStream<Uint8Array>, max: number, length: number, ext: UploadExt,
): Promise<Uint8Array> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > max - total || next.value.byteLength > length - total)
        throw new UploadError("File exceeds allowed size or declared length.", 413);
      total += next.value.byteLength;
      chunks.push(next.value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
    reader.releaseLock();
  }
  if (!total) throw new UploadError("The file is empty.",400);
  if (total !== length) throw new UploadError("Content size is invalid.",413);
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { body.set(chunk,at); at += chunk.byteLength; }
  if (!looksLike(ext,body.subarray(0,Math.min(16,total))))
    throw new UploadError("File header does not match its extension.",415);
  return body;
}

/** Multipart keeps only one 5 MiB part and one incoming network chunk in memory.
 * All non-final parts are 5 MiB, satisfying the R2 multipart minimum.
 * A missing Content-Length is permitted only for a trusted, internal import.
 */
async function storeVideoInParts(
  env: Env, ref: UploadRef, source: ReadableStream<Uint8Array>, max: number,
  declared: number | null,
): Promise<{bytes:number;parts:UploadPartDigest[]}> {
  const reader = source.getReader();
  const fingerprints: UploadPartDigest[] = [];
  const completedParts: Awaited<ReturnType<R2MultipartUpload["uploadPart"]>>[] = [];
  let piece = new Uint8Array(VIDEO_PART_BYTES);
  let filled = 0, total = 0, headerFilled = 0;
  const header = new Uint8Array(12);
  const state: {upload:R2MultipartUpload|null} = {upload:null};
  let commitAttempted = false;
  const savePart = async (data: Uint8Array) => {
    if (!state.upload) state.upload = await env.UPLOADS!.createMultipartUpload(key(ref), {
      httpMetadata:{contentType:"video/mp4"},
    });
    const hash = await digestPart(data);
    const part = await state.upload.uploadPart(completedParts.length + 1,data);
    completedParts.push(part);
    fingerprints.push({bytes:data.byteLength,sha256:hash});
  };
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const bytes = next.value;
      if (bytes.byteLength > max - total ||
          (declared !== null && bytes.byteLength > declared - total))
        throw new UploadError("File exceeds allowed size or declared length.",413);
      total += bytes.byteLength;
      if (headerFilled < 12) {
        const n = Math.min(12-headerFilled,bytes.byteLength);
        header.set(bytes.subarray(0,n),headerFilled);
        headerFilled += n;
        if (headerFilled === 12 && !looksLike("mp4",header))
          throw new UploadError("File header does not match its extension.",415);
      }
      let at = 0;
      while (at < bytes.byteLength) {
        const n = Math.min(VIDEO_PART_BYTES-filled,bytes.byteLength-at);
        piece.set(bytes.subarray(at,at+n),filled);
        filled += n; at += n;
        if (filled === VIDEO_PART_BYTES) {
          await savePart(piece);
          piece = new Uint8Array(VIDEO_PART_BYTES);
          filled = 0;
        }
      }
    }
    if (!total) throw new UploadError("The file is empty.",400);
    if (headerFilled < 12) throw new UploadError("File header does not match its extension.",415);
    if (declared !== null && declared !== total)
      throw new UploadError("Content size is invalid.",413);
    if (filled) await savePart(piece.subarray(0,filled));
    if (!state.upload || !completedParts.length) throw new Error("No video parts were stored.");
    // Never retry or abort after an ambiguous multipart commit attempt.
    commitAttempted = true;
    await state.upload.complete(completedParts);
    return {bytes:total,parts:fingerprints};
  } catch (error) {
    // No multipart handle means no completed object was submitted. If a
    // multipart handle exists, only a CONFIRMED abort frees the quota.
    // After complete() is attempted, even an exception is ambiguous.
    let definitelyAbsent = !state.upload && !commitAttempted;
    if (state.upload && !commitAttempted) {
      try {
        await state.upload.abort();
        definitelyAbsent = true;
      } catch { /* unknown remote part state: retain reservation */ }
    }
    throw new MultipartStoreFailure(error,definitelyAbsent);
  } finally {
    try { await reader.cancel(); } catch { /* already finished */ }
    reader.releaseLock();
  }
}

/** PUT /upload/:id/:token is the only unauthenticated write.
 * Native GitHub imports may omit Content-Length and request chunked readback.
 * The public upload route never supplies these internal options.
 */
export async function handleUploadPut(
  request: Request, env: Env,
  options?:{
    internalUnknownLength?:boolean;
    verifyBeforeFinalize?:(reference:UploadRef,parts:UploadPartDigest[])=>Promise<void>;
  },
): Promise<Response> {
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
  // Pre-write request rejection is definitive: consume the invalid bearer
  // grant as failed, freeing reserved bytes without granting a second PUT.
  // The conditional update cannot invalidate another request's active claim.
  const rejectUnused=async(message:string,status:number):Promise<Response>=>{
    await env.DB.prepare("UPDATE uploads SET status='failed' WHERE id=? AND status='pending'")
      .bind(id).run();
    return json({error:message},status);
  };
  const lengthHeader = request.headers.get("content-length");
  const length = lengthHeader === null ? null : Number(lengthHeader);
  if ((length === null && !options?.internalUnknownLength) ||
      (length !== null && (!Number.isSafeInteger(length) || length <= 0)))
    return rejectUnused("Content-Length is required.",411);
  if (length !== null && length > row.max_bytes)
    return rejectUnused("File exceeds allowed size.",413);
  if (!request.body) return rejectUnused("The file is empty.",400);
  const claim = await env.DB.prepare("UPDATE uploads SET status = 'uploading' WHERE id = ? AND status = 'pending' AND expires_at > ?")
    .bind(id,new Date().toISOString()).run();
  if ((claim.meta.changes ?? 0) !== 1) return gone();
  const ref: UploadRef = {id,ext:row.ext};
  let writeStarted = false;
  // A failed database response may still have committed. Never delete after
  // attempting to mark stored, and never reuse a token after starting R2.
  let finalizationAttempted = false;
  try {
    let size: number;
    let fingerprints: UploadPartDigest[] = [];
    if (row.ext === "mp4") {
      // The multipart helper reports whether failures left an object absent.
      const stored = await storeVideoInParts(env,ref,request.body,row.max_bytes,length);
      writeStarted = true;
      size = stored.bytes;
      fingerprints = stored.parts;
    } else {
      if (length === null) throw new UploadError("Content-Length is required.",411);
      const body = await boundedImageBody(request.body,row.max_bytes,length,row.ext);
      writeStarted = true;
      await env.UPLOADS.put(key(ref),body,{httpMetadata:{contentType:TYPES[row.ext].mime}});
      size = body.byteLength;
    }
    // Independent readback must occur before any prepared video becomes ready.
    if(options?.verifyBeforeFinalize)await options.verifyBeforeFinalize(ref,fingerprints);
    finalizationAttempted = true;
    const mark = await env.DB.prepare("UPDATE uploads SET status = 'stored', bytes = ? WHERE id = ? AND status = 'uploading'")
      .bind(size,id).run();
    if ((mark.meta.changes ?? 0) !== 1) throw new Error("Failed to finalize the upload record.");
    return json({ok:true,reference:formatUploadRef(ref),bytes:size});
  } catch (error) {
    const cause=error instanceof MultipartStoreFailure ? error.original : error;
    let definitelyAbsent=!writeStarted &&
      (!(error instanceof MultipartStoreFailure) || error.definitelyAbsent);
    if (writeStarted && !finalizationAttempted && options?.verifyBeforeFinalize && env.UPLOADS) {
      // A verified import whose readback failed is not draft-ready. Only a
      // CONFIRMED deletion permits the failed terminal state and quota release.
      try {
        await env.UPLOADS.delete(key(ref));
        definitelyAbsent=true;
      } catch { /* ambiguous object remains reserved and unavailable */ }
    }
    if (definitelyAbsent) {
      // Failed is terminal, excluded from the 3 GiB reservation sum. Never
      // reopen a consumed link, even for definitely pre-write input errors.
      try {
        await env.DB.prepare("UPDATE uploads SET status='failed' WHERE id=? AND status='uploading'")
          .bind(id).run();
      } catch { /* uncertain database state: fail closed, never retry */ }
    }
    return cause instanceof UploadError
      ? json({error:cause.message},cause.status)
      : json({error:"Upload failed. Contact support if the link has been consumed."},500);
  }
}
/** One-time bearer link lookup, valid only until the upload is completed or expired.
 * This MUST NOT disclose the upload token in any response.
 */
export async function pendingUploadPageInfo(
  db:D1Database,id:string,token:string,
):Promise<{ext:UploadExt;maxBytes:number}|null> {
  if(!/^[a-f0-9]{32}$/.test(id)|| !/^[A-Za-z0-9_-]{20,64}$/.test(token))return null;
  await ensureUploads(db);
  const row=await db.prepare(
    "SELECT token_hash,ext,max_bytes,status,expires_at FROM uploads WHERE id=?"
  ).bind(id).first<Pick<UploadRow,"token_hash"|"ext"|"max_bytes"|"status"|"expires_at">>();
  if(!row||row.status!=="pending"||row.expires_at<=new Date().toISOString()||
     !safeEqual(await sha256(token),row.token_hash))return null;
  return {ext:row.ext,maxBytes:row.max_bytes};
}

/** Only the OAuth/GitHub owner may query whether an upload can be used in a draft. */
export async function uploadStatusForOwner(db:D1Database,reference:string,login:string):
  Promise<{reference:string;status:"pending"|"uploading"|"stored"|"failed"|"expired";bytes:number|null;max_bytes:number}|null> {
  const parsed=parseUploadRef(reference);
  if(!parsed||!login.trim())return null;
  await ensureUploads(db);
  const row=await db.prepare(
    "SELECT ext,status,created_by,expires_at,bytes,max_bytes FROM uploads WHERE id=?"
  ).bind(parsed.id).first<Pick<UploadRow,"ext"|"status"|"created_by"|"expires_at"|"bytes"|"max_bytes">>();
  if(!row||row.ext!==parsed.ext||row.created_by?.toLowerCase()!==login.toLowerCase())return null;
  const expired=row.status==="pending"&&row.expires_at<=new Date().toISOString();
  return {reference,status:expired?"expired":row.status,bytes:row.bytes,max_bytes:row.max_bytes};
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

/** The same completed, owner-bound upload check, restricted to MP4 video. */
export async function isStoredOwnerVideo(db: D1Database, reference: string, login: string): Promise<boolean> {
  const ref = parseUploadRef(reference);
  if (!ref || ref.ext !== "mp4") return false;
  await ensureUploads(db);
  const row = await db.prepare(
    "SELECT status, ext, created_by FROM uploads WHERE id = ?"
  ).bind(ref.id).first<Pick<UploadRow,"status"|"ext"|"created_by">>();
  return !!row && row.status === "stored" && row.ext === "mp4" &&
    row.created_by?.toLowerCase() === login.toLowerCase();
}

/** Raw private object access for internal preflight, review preview and approved publication. */
export async function readUpload(env: Env, ref: UploadRef): Promise<ArrayBuffer> {
  if (!env.UPLOADS) throw new Error("File uploads are not set up on this server.");
  const object = await env.UPLOADS.get(key(ref));
  if (!object) throw new Error("Upload " + formatUploadRef(ref) + " was not found or has expired.");
  return object.arrayBuffer();
}
