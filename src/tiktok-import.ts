/**
 * On-demand, signed-in migration of an already-attached TikTok GitHub image
 * into the same private R2 upload store used by browser uploads.
 *
 * Never fetch arbitrary user-supplied URLs: the source is selected by index
 * from an existing saved, independent TikTok gallery. Never approve or send.
 */
import type { Env } from "./env.ts";
import { getPost, replaceTikTokDraftImage } from "./db.ts";
import { checkImageUrl, fetchImage, MAX_IMAGE_BYTES, parseGitHubUrl } from "./media.ts";
import { createUpload, handleUploadPut, isStoredOwnerUpload, looksLike, parseUploadRef, readUpload,
  type UploadExt } from "./upload.ts";

export class TikTokImportError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const digest = (bytes: ArrayBuffer): Promise<ArrayBuffer> => crypto.subtle.digest("SHA-256", bytes);
function identical(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a), right = new Uint8Array(b);
  return left.every((value, index) => value === right[index]);
}

export async function importTikTokLinkedImage(
  env: Env, postId: string, index: number, expectedVersion: string, actor: string, origin: string,
): Promise<{ reference: string; updated_at: string }> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 35)
    throw new TikTokImportError("Invalid TikTok image position.");
  const post = await getPost(env.DB, postId);
  if (!post) throw new TikTokImportError("Post not found.", 404);
  if (!["draft", "rejected"].includes(post.status) || post.approved_at)
    throw new TikTokImportError("Only unapproved drafts can import images.", 409);
  if (post.updated_at !== expectedVersion)
    throw new TikTokImportError("The draft changed. Reload before importing images.", 409);
  if (!post.tiktok_enabled || !post.tiktok_images)
    throw new TikTokImportError("Enable TikTok and save its separate photo gallery first.", 409);
  if (post.tiktok_video)
    throw new TikTokImportError("Remove the TikTok video before preparing photos.", 409);
  const source = post.tiktok_images[index];
  if (!source) throw new TikTokImportError("TikTok image not found.", 404);
  if (!parseGitHubUrl(source) || checkImageUrl(source))
    throw new TikTokImportError("Only existing GitHub-linked TikTok images can be imported.");
  if (!env.UPLOADS) throw new TikTokImportError("Private media storage is not configured.", 503);

  // fetchImage restricts the outbound host to GitHub's raw content/API and
  // enforces the same 10 MB maximum as private image uploads.
  const fetched = await fetchImage(env, source);
  const ext = fetched.name.split(".").pop()?.toLowerCase() as UploadExt | undefined;
  if (!ext || !["jpg", "jpeg", "png", "gif"].includes(ext))
    throw new TikTokImportError("Unsupported source image format.");
  if (!fetched.bytes.byteLength || fetched.bytes.byteLength > MAX_IMAGE_BYTES)
    throw new TikTokImportError("The image is empty or larger than 10 MB.");
  if (!looksLike(ext, new Uint8Array(fetched.bytes.slice(0, 16))))
    throw new TikTokImportError("The downloaded file is not a valid image of the expected type.");

  // The existing one-use, owner-bound upload path performs quota accounting,
  // token claims, MIME sniffing, private R2 storage and finalization. Reuse
  // that path internally rather than adding a second, weaker R2 write path.
  const grant = await createUpload(env, origin, { filename: fetched.name, actor });
  const hash = await digest(fetched.bytes);
  const put = new Request(grant.upload_url, {
    method: "PUT", headers: { "Content-Length": String(fetched.bytes.byteLength) },
    body: fetched.bytes,
  });
  const stored = await handleUploadPut(put, env, {
    verifyBeforeFinalize: async (ref) => {
      const readback = await readUpload(env, ref);
      if (readback.byteLength !== fetched.bytes.byteLength || !identical(hash, await digest(readback)))
        throw new Error("Private media integrity verification failed.");
    },
  });
  if (!stored.ok)
    throw new TikTokImportError("The private image copy was not confirmed. Reload before retrying.", 502);
  if (!parseUploadRef(grant.reference) || !(await isStoredOwnerUpload(env.DB, grant.reference, actor)))
    throw new TikTokImportError("The imported image did not become an owned, ready private upload.", 502);

  // A stale version, changed source index or publication prevents attachment.
  // A stored-but-unattached object may remain until its 45-day lifecycle ends.
  let updated: string | null;
  try {
    updated = await replaceTikTokDraftImage(
      env.DB, postId, index, source, grant.reference, expectedVersion,
    );
  } catch {
    // A lost database acknowledgment may follow a committed replacement.
    // Never retry the write here and never delete a verified private object.
    throw new TikTokImportError(
      "The import's final save could not be confirmed. Reload the draft and inspect the TikTok gallery before retrying.", 502,
    );
  }
  if (!updated) throw new TikTokImportError(
    "The draft changed while importing. Reload to check which images were saved; nothing was published.", 409,
  );
  return { reference: grant.reference, updated_at: updated };
}
