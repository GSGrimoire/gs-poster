/**
 * TikTok inside the one-PIN release (issue #61 point 5). The owner checks
 * TikTok in the editor's release form; the same PIN approval then sends ONE
 * inbox transfer of the SAVED TikTok media and caption. It is an inbox
 * transfer, not a TikTok publication: Gus finishes the post in the TikTok app.
 *
 * Nothing here adds a new way to reach TikTok. The send reuses the existing
 * claimed, exactly-once transfer functions (claim row first, no automatic
 * retry, uncertain outcomes kept for human reconciliation). Direct Post stays
 * hidden and is never chosen here.
 */
import type { Env } from "./env.ts";
import { tiktokMedia, type Post } from "./db.ts";
import { parseUploadRef } from "./upload.ts";
import { canRetryTikTokTransfer, startTikTokInboxTransfer, type TikTokInboxTransfer } from "./tiktok-inbox.ts";
import { startTikTokContentTransfer } from "./tiktok-posting.ts";
import { TIKTOK_CAPTION_PHOTO, TIKTOK_CAPTION_VIDEO, TIKTOK_PHOTO_MAX } from "./platforms.ts";

export type TikTokReleasePlan =
  | { ok: true; type: "PHOTO" | "VIDEO"; count: number; title: string; caption: string; retry: boolean }
  | { ok: false; reason: string; offered: boolean };

/**
 * Whether this post's saved TikTok target can go out with the approval, and
 * exactly what would be sent. Pure: decided from the saved post, the TikTok
 * connection and any earlier transfer. `offered:false` hides the option.
 */
export function tiktokReleasePlan(
  p: Post, conn: { scopes: string } | null, transfer: TikTokInboxTransfer | null,
): TikTokReleasePlan {
  if (!p.tiktok_enabled) return { ok: false, offered: false, reason: "TikTok is not selected for this draft." };
  const retry = !!transfer && canRetryTikTokTransfer(transfer);
  if (transfer && !retry)
    return { ok: false, offered: false, reason: `Already sent to TikTok (${transfer.status.replaceAll("_", " ")}). See the TikTok card.` };
  if (!conn) return { ok: false, offered: true, reason: "Connect TikTok first (TikTok settings)." };
  if (!conn.scopes.split(",").includes("video.upload"))
    return { ok: false, offered: true, reason: "The TikTok connection lacks inbox upload permission. Reconnect in TikTok settings." };
  const media = tiktokMedia(p);
  // Never leak an internal GS Poster draft name into a public TikTok title.
  const title = (p.tiktok_title ?? "").trim();
  const text = p.tiktok_caption ?? p.message;
  if (media.video) {
    if (!/^upload:\/\/[a-f0-9]{32}\.mp4$/.test(media.video))
      return { ok: false, offered: true, reason: "TikTok needs a privately uploaded MP4. Reattach the video." };
    if (text.length > TIKTOK_CAPTION_VIDEO) return { ok: false, offered: true, reason: `The TikTok caption is over ${TIKTOK_CAPTION_VIDEO} characters.` };
    return { ok: true, type: "VIDEO", count: 1, title, caption: text, retry };
  }
  if (!media.images.length) return { ok: false, offered: true, reason: "Add photos or a video for TikTok first." };
  if (!title) return { ok: false, offered: true, reason: "Enter a public TikTok carousel title in the TikTok editor." };
  if (title.length > 90) return { ok: false, offered: true, reason: "TikTok carousel titles cannot exceed 90 characters." };
  if (media.images.length > TIKTOK_PHOTO_MAX) return { ok: false, offered: true, reason: `TikTok carousels hold at most ${TIKTOK_PHOTO_MAX} photos.` };
  if (media.images.some((u) => { const r = parseUploadRef(u); return !r || r.ext === "mp4"; }))
    return { ok: false, offered: true, reason: "TikTok needs privately uploaded photos. Reattach them through Add photos." };
  if (text.length > TIKTOK_CAPTION_PHOTO) return { ok: false, offered: true, reason: `The TikTok caption is over ${TIKTOK_CAPTION_PHOTO} characters.` };
  return { ok: true, type: "PHOTO", count: media.images.length, title, caption: text, retry };
}

/**
 * Send the saved TikTok media to the inbox, fenced on the approved version.
 * Throws with a plain message on refusal or uncertainty; the transfer row
 * records which, and the TikTok card offers the safe recovery.
 */
export async function sendTikTokOnApproval(
  env: Env, plan: Extract<TikTokReleasePlan, { ok: true }>, postId: string, version: string, actor: string, aiGenerated: boolean,
): Promise<TikTokInboxTransfer> {
  if (plan.type === "VIDEO") return startTikTokInboxTransfer(env, postId, version, actor);
  return startTikTokContentTransfer(env, postId, version, actor, {
    mode: "MEDIA_UPLOAD", mediaType: "PHOTO", caption: plan.caption, title: plan.title, privacy: "",
    disableComment: false, disableDuet: false, disableStitch: false, autoMusic: false,
    brandOrganic: false, brandContent: false, aiGenerated,
  });
}
