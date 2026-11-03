/**
 * One-page draft editor: edit everything in place, press Save (no PIN), then
 * release exactly what is saved (PIN). Saving never approves or publishes.
 * New media still arrives through the private upload/attach routes; the editor
 * can only remove media or change Bluesky alternative text.
 */
import { esc } from "./html.ts";
import { tiktokMedia, type BlueskyDraft, type EditorDraft, type Post } from "./db.ts";
import { BSKY_TEXT_LIMIT, textLength } from "./bluesky.ts";
import { localToUtc, toLocalInput } from "./time.ts";
import { captionLimit, checkTarget, PLATFORM_ORDER, PLATFORMS, platformRulesJson, FACEBOOK_CAPTION_MAX,
  type PlatformId, type TargetState } from "./platforms.ts";
import type { TikTokReleasePlan } from "./tiktok-release.ts";
import { parseGitHubUrl } from "./media.ts";
import { countHashtags, defaultItem, INSTAGRAM_BACKGROUNDS, INSTAGRAM_CAPTION_MAX, INSTAGRAM_FRAMES, INSTAGRAM_MAX_ITEMS,
  INSTAGRAM_MAX_ZOOM, INSTAGRAM_PLAN_JS, instagramSaveErrors, readInstagramItems,
  type InstagramDraft, type InstagramFrame } from "./instagram.ts";

const FB_MAX = FACEBOOK_CAPTION_MAX;
const MAX_ALT = 1000;

export interface EditorParse {
  errors: string[];
  next?: EditorDraft;
  bluesky?: BlueskyDraft | null;
  instagram?: InstagramDraft | null;
}

/** Every photo already on the post, in a stable order, for the Instagram picker. */
export function postVideos(p:Post):string[] {
  const tt=tiktokMedia(p);
  return [...new Set([p.video,p.bluesky?.video?.url,p.bluesky_paused?.video?.url,tt.video,
    p.instagram?.video,p.instagram_paused?.video].filter((x):x is string=>!!x))];
}

export function postPhotos(p: Post): string[] {
  const all = [...p.images, ...(p.tiktok_images ?? []), ...(p.bluesky?.images.map((i) => i.url) ?? []),
    ...(p.instagram?.items.map((i) => i.url) ?? []),
    ...(p.instagram_paused?.items.map((i) => i.url) ?? []),
    ...(p.bluesky_paused?.images.map((i) => i.url) ?? [])];
  return [...new Set(all)];
}

const text = (form: FormData, key: string, fallback: string): string => {
  const v = form.get(key);
  return v === null ? fallback : String(v);
};
const short = (form: FormData, key: string, fallback: string | null): string | null => {
  const v = form.get(key);
  if (v === null) return fallback;
  const t = String(v).trim().slice(0, 120);
  return t || null;
};
const kept = <T>(items: T[], form: FormData, prefix: string): T[] =>
  items.filter((_, i) => form.get(prefix + i) !== "1");

/**
 * Per-platform photo order (#33). The form sends the saved positions in the
 * new order, e.g. "2,0,1". Only an exact rearrangement of the saved photos is
 * accepted, so reordering can never add, repeat or drop a photo; removal stays
 * the separate Remove box. Missing field: saved order.
 */
export function readOrder(form: FormData, key: string, n: number): number[] | null {
  const raw = form.get(key);
  if (raw === null || String(raw) === "") return Array.from({ length: n }, (_, i) => i);
  const parts = String(raw).split(",");
  if (parts.length !== n || !parts.every((x) => /^\d{1,3}$/.test(x))) return null;
  const order = parts.map(Number);
  return new Set(order).size === n && order.every((i) => i < n) ? order : null;
}
/** Apply the order, then drop photos ticked for removal (by saved position). */
const ordered = <T>(items: T[], order: number[], form: FormData, prefix: string): T[] =>
  order.filter((i) => form.get(prefix + i) !== "1").map((i) => items[i]);

/** Read the editor form against the current post. Only hard limits block a save. */
export function parseEditorForm(form: FormData, cur: Post, tz: string): EditorParse {
  const errors: string[] = [];
  const facebook = form.get("p_facebook") === "1";
  const blueskyOn = form.get("p_bluesky") === "1";
  const tiktok = form.get("p_tiktok") === "1";
  const instagramOn = form.get("p_instagram") === "1";
  if (!facebook && !blueskyOn && !tiktok && !instagramOn) errors.push("Choose at least one platform.");

  const message = text(form, "message", cur.message);
  if (message.length > FB_MAX) errors.push(`The Facebook caption is ${message.length} characters; Facebook allows ${FB_MAX}.`);

  const savedBluesky = cur.bluesky ?? cur.bluesky_paused ?? null;
  const savedInstagram = cur.instagram ?? cur.instagram_paused ?? null;
  const fbOrder = readOrder(form, "order_fb", cur.images.length);
  const ttOrder = cur.tiktok_images === null ? [] : readOrder(form, "order_tt", cur.tiktok_images.length);
  const bsOrder = readOrder(form, "order_bs", savedBluesky?.images.length ?? 0);
  if (!fbOrder || !ttOrder || !bsOrder) errors.push("Could not read the photo order. Reload the page and try again.");
  const images = ordered(cur.images, fbOrder ?? [], form, "remove_fb_");
  const video = cur.video && form.get("remove_fb_video") !== "1" ? cur.video : null;
  let tiktokImages = cur.tiktok_images === null ? null : ordered(cur.tiktok_images, ttOrder ?? [], form, "remove_tt_");
  let tiktokVideo = cur.tiktok_video && form.get("remove_tt_video") !== "1" ? cur.tiktok_video : null;
  // Stop TikTok-only uploads from mutating a shared Facebook gallery.
  // A newly enabled/legacy TikTok target gets its own copy of the saved photos.
  if (tiktok && (cur.tiktok_images === null || form.get("tt_copy_fb") === "1")) {
    tiktokImages = [...images];
    tiktokVideo = video;
  }
  const ttCaptionRaw = text(form, "tiktok_caption", cur.tiktok_caption ?? "").trim();
  const tiktokCaption = ttCaptionRaw || null;
  const tiktokTitle = text(form, "tiktok_title", cur.tiktok_title ?? "").trim();
  if (tiktokTitle.length > 90) errors.push("TikTok photo title cannot exceed 90 characters.");
  const ttIsVideo = tiktokImages === null ? !!video : !!tiktokVideo;
  const ttLimit = captionLimit("tiktok", { photos: 1, video: ttIsVideo });
  if (tiktok && (tiktokCaption ?? message).length > ttLimit)
    errors.push(`The TikTok caption is too long; TikTok allows ${ttLimit} characters for this format.`);

  let bluesky: BlueskyDraft | null = null;
  if (blueskyOn || savedBluesky) {
    const base = savedBluesky ?? { caption: "", images: [], video: null, patreon: null };
    const caption = text(form, "bs_caption", base.caption);
    if (blueskyOn && textLength(caption) > BSKY_TEXT_LIMIT) errors.push(`The Bluesky caption is over ${BSKY_TEXT_LIMIT} characters.`);
    const bsAll = base.images.map((img, i) => ({ url: img.url, alt: text(form, "bs_alt_" + i, img.alt).trim() }));
    let bsImages = ordered(bsAll, savedBluesky ? bsOrder ?? [] : [], form, "remove_bs_");
    const copyFbVideo=form.get("bs_copy_fb_video")==="1";
    if(copyFbVideo && !cur.video)errors.push("Facebook has no video to copy to Bluesky.");
    const copiedAlt=text(form,"bs_copy_video_alt",base.video?.alt??"").trim();
    if(copyFbVideo && !copiedAlt)errors.push("Describe the Facebook video before copying it to Bluesky.");
    const bsVideo=copyFbVideo && cur.video
      ? {url:cur.video,alt:copiedAlt}
      : base.video && form.get("remove_bs_video")!=="1"
        ? {url:base.video.url,alt:text(form,"bs_video_alt",base.video.alt).trim()} : null;
    if(copyFbVideo && cur.video)bsImages=[];
    for (const a of [...bsImages.map((x) => x.alt), ...(bsVideo ? [bsVideo.alt] : [])])
      if (blueskyOn && a.length > MAX_ALT) errors.push(`Alternative text is limited to ${MAX_ALT} characters.`);
    const patreonUrl = text(form, "bs_patreon_url", base.patreon?.url ?? "").trim();
    bluesky = {
      caption, images: bsImages, video: bsVideo,
      patreon: patreonUrl ? {
        url: patreonUrl,
        title: text(form, "bs_patreon_title", base.patreon?.title ?? "").trim(),
        description: text(form, "bs_patreon_description", base.patreon?.description ?? "").trim(),
      } : null,
    };
  }

  // Instagram may only use photos already on this post; new media still comes
  // through the private upload routes.
  let instagram: InstagramDraft | null = null;
  if (instagramOn || savedInstagram) {
    const base = savedInstagram ?? { caption: "", frame: "4:5" as InstagramFrame, items: [], video:null };
    const rawItems = form.get("ig_items");
    const items = rawItems === null ? base.items : readInstagramItems(String(rawItems));
    if (!items) errors.push("Could not read the Instagram photo settings. Reload the page and try again.");
    else {
      const videoSource=text(form,"ig_video_source",base.video??"").trim();
      instagram = {
        caption: text(form,"ig_caption",base.caption),
        frame: text(form,"ig_frame",base.frame) as InstagramFrame,
        items,
        ...(videoSource?{video:videoSource}:{}),
      };
      if(instagramOn)errors.push(...instagramSaveErrors(instagram,
        new Set(postPhotos(cur)),new Set(postVideos(cur))));
    }
  }

  let scheduledAt: string | null = cur.scheduled_at;
  const whenRaw = form.get("when");
  if (whenRaw !== null) {
    const w = String(whenRaw).trim();
    if (!w) scheduledAt = null;
    else {
      try { scheduledAt = localToUtc(w, tz).toISOString(); }
      catch { errors.push("Could not read the publish time."); }
    }
  }
  if (errors.length) return { errors };
  return {
    errors,
    bluesky,
    instagram,
    next: {
      message, tiktok_caption: tiktokCaption, tiktok_title: tiktokTitle || null,
      bluesky_enabled: blueskyOn, instagram_enabled: instagramOn,
      images, tiktok_images: tiktokImages, video,
      tiktok_video: tiktokVideo, facebook_enabled: facebook, tiktok_enabled: tiktok,
      scheduled_at: scheduledAt, label: short(form, "label", cur.label), release: short(form, "release", cur.release),
    },
  };
}

export interface EditorView {
  post: Post;
  csrf: string;
  tz: string;
  whenText: string;
  error?: string;
  notice?: string;
  checksHtml: string;
  releaseProblems: string[];
  mediaPanel: string;
  tiktokCard: string;
  /** What the one-PIN release would send to TikTok (#61). */
  tiktokPlan?: TikTokReleasePlan;
  mediaLooksPending: boolean;
  createdLine: string;
}

function tile(src: string, alt: string, removeName: string, extra = "", index?: number): string {
  const moves = index === undefined ? "" : `<div class="tile-move"><span class="tile-pos" aria-hidden="true">${index + 1}</span>
      <button type="button" data-move="-1" aria-label="Move ${esc(alt)} earlier">&#8249;</button>
      <button type="button" data-move="1" aria-label="Move ${esc(alt)} later">&#8250;</button></div>`;
  return `<figure class="tile" data-tile="photo"${index === undefined ? "" : ` data-index="${index}" draggable="true"`}><div class="tile-frame"><img loading="lazy" src="${esc(src)}" alt="${esc(alt)}">
    <span class="tile-ratio" data-ratio-badge hidden></span></div>${moves}
    <label class="tile-remove"><input type="checkbox" name="${esc(removeName)}" value="1"> Remove</label>${extra}</figure>`;
}

function video(src: string, removeName: string, extra = ""): string {
  return `<figure class="tile tile-video" data-tile="video"><video controls playsinline preload="metadata" src="${esc(src)}"></video>
    <label class="tile-remove"><input type="checkbox" name="${esc(removeName)}" value="1"> Remove video</label>${extra}</figure>`;
}

/** Saved state of each platform's target, for the first render of the checks. */
export function targetStates(p: Post): Record<PlatformId, TargetState> {
  const bs = p.bluesky ?? p.bluesky_paused ?? null;
  const tt = tiktokMedia(p);
  const ttShared = p.tiktok_images === null;
  return {
    facebook: { id: "facebook", captionLength: p.message.length, photos: p.video ? 0 : p.images.length, video: !!p.video, missingAlt: 0 },
    bluesky: { id: "bluesky", captionLength: bs ? textLength(bs.caption) : 0,
      photos: bs?.video ? 0 : (bs?.images.length ?? 0), video: !!bs?.video,
      missingAlt: (bs?.images.filter((i) => !i.alt.trim()).length ?? 0) + (bs?.video && !bs.video.alt.trim() ? 1 : 0) },
    instagram: { id: "instagram", captionLength: p.instagram?.caption.length ?? 0,
      photos: p.instagram?.items.length ?? 0, video: !!p.instagram?.video, missingAlt: 0, hashtags: countHashtags(p.instagram?.caption ?? "") },
    tiktok: { id: "tiktok", captionLength: (p.tiktok_caption ?? p.message).length,
      photos: ttShared ? (p.video ? 0 : p.images.length) : tt.images.length,
      video: ttShared ? !!p.video : !!tt.video, missingAlt: 0 },
  };
}

function formatLine(id: PlatformId): string {
  const r = PLATFORMS[id];
  const caps = r.caption.photo === r.caption.video
    ? `${r.caption.photo.toLocaleString("en-GB")} characters`
    : `${r.caption.photo.toLocaleString("en-GB")} characters with photos, ${r.caption.video.toLocaleString("en-GB")} with video`;
  return [
    `Up to ${r.maxPhotos} photos or 1 video`,
    caps,
    r.altRequired ? "descriptions required" : "",
    r.maxHashtags ? `${r.maxHashtags} hashtags` : "",
    r.framed ? "JPEG photos or an MP4 Reel download" : `shows best at ${r.aspect.label}`,
  ].filter(Boolean).join(" · ");
}

function checkItems(t: TargetState): string {
  const c = checkTarget(t);
  if (!c.errors.length && !c.warnings.length) return `<li class="ok">Ready for ${esc(PLATFORMS[t.id].label)}.</li>`;
  return [...c.errors.map((e) => `<li class="e">${esc(e)}</li>`), ...c.warnings.map((w) => `<li class="w">${esc(w)}</li>`)].join("");
}

const photos = (n: number) => (n ? n + (n === 1 ? " photo" : " photos") : "text only");
const chip = (name: string, label: string, on: boolean) =>
  `<label class="platform-chip"><input type="checkbox" name="${name}" value="1" data-platform-toggle="${name.slice(2)}"${on ? " checked" : ""}> ${label}</label>`;

export function renderDraftEditor(v: EditorView): string {
  const p = v.post;
  const id = esc(p.id);
  const bs = p.bluesky ?? p.bluesky_paused ?? null;
  const tt = tiktokMedia(p);
  const ttShared = p.tiktok_images === null;
  const ttImportIndices = !ttShared && !tt.video ? tt.images.flatMap((url, i) => parseGitHubUrl(url) ? [i] : []) : [];
  const hide = (on: boolean) => (on ? "" : " hidden");
  const on: Record<PlatformId, boolean> = { facebook: p.facebook_enabled, bluesky: !!p.bluesky, tiktok: !!p.tiktok_enabled, instagram: !!p.instagram };
  const ig = p.instagram ?? p.instagram_paused ?? null;
  const pool = postPhotos(p);
  const igItems = ig?.items ?? [];
  const igVideo=ig?.video??null;
  const availableVideos=postVideos(p);
  const igFrame: InstagramFrame = ig?.frame ?? "4:5";
  const states = targetStates(p);
  const fbMedia = p.video
    ? video(`/video/${p.id}/facebook`, "remove_fb_video")
    : p.images.map((_, i) => tile(`/media/${p.id}/${i}`, `Facebook photo ${i + 1}`, "remove_fb_" + i, "", p.images.length > 1 ? i : undefined)).join("");
  const bsMedia = bs?.video
    ? video(`/video/${p.id}/bluesky`, "remove_bs_video",
      `<label>Describe the video<input type="text" name="bs_video_alt" maxlength="${MAX_ALT}" value="${esc(bs.video.alt)}"></label>`)
    : (bs?.images ?? []).map((img, i) => tile(`/media/${p.id}/${i}?platform=bluesky`, `Bluesky photo ${i + 1}`, "remove_bs_" + i,
      `<label>Describe the image<input type="text" name="bs_alt_${i}" maxlength="${MAX_ALT}" value="${esc(img.alt)}" placeholder="Required by Bluesky"></label>`, (bs?.images.length ?? 0) > 1 ? i : undefined)).join("");
  const ttMedia = ttShared
    ? `<p class="hint shared-note">TikTok is currently using legacy shared Facebook media. Enabling TikTok and saving makes its gallery independent.</p>`
    : tt.video
      ? video(`/video/${p.id}/tiktok`, "remove_tt_video")
      : tt.images.map((_, i) => tile(`/media/${p.id}/${i}?platform=tiktok`, `TikTok photo ${i + 1}`, "remove_tt_" + i, "", tt.images.length > 1 ? i : undefined)).join("");
  const empty = '<p class="hint">Nothing yet.</p>';
  const when = p.scheduled_at ? toLocalInput(new Date(p.scheduled_at), v.tz) : "";
  const releaseTargets = [
    p.facebook_enabled ? `<label><input type="checkbox" name="target_facebook" value="1" checked> Facebook · ${p.video ? "video" : photos(p.images.length)}</label>` : "",
    p.bluesky ? `<label><input type="checkbox" name="target_bluesky" value="1" checked> Bluesky · ${bs!.video ? "video" : photos(bs!.images.length)}</label>` : "",
  ].join("");
  const ttPlan = v.tiktokPlan;
  const ttOk = ttPlan?.ok ? ttPlan : null;
  const fbBs = !!(p.facebook_enabled || p.bluesky);
  const canRelease = fbBs || !!ttOk;
  const scheduledOthers = fbBs && p.scheduled_at;
  const ttPreview = ttOk ? (ttOk.type === "VIDEO"
    ? `<video class="tt-video" controls playsinline preload="metadata" src="/video/${id}/tiktok"></video>`
    : `<div class="tt-strip">${Array.from({ length: Math.min(ttOk.count, 12) }, (_, i) => `<img loading="lazy" src="/media/${id}/${i}?platform=tiktok" alt="TikTok photo ${i + 1}">`).join("")}${ttOk.count > 12 ? `<span class="tt-more">+${ttOk.count - 12}</span>` : ""}</div>`) : "";
  const ttBlock = ttOk ? `
      <fieldset class="tt-release">
        <legend class="sr-only">TikTok</legend>
        <label class="tt-target"><input type="checkbox" name="target_tiktok" value="1" checked data-tt-toggle> ${ttOk.retry ? "Send again: " : ""}TikTok · ${ttOk.type === "VIDEO" ? "video" : ttOk.count + "-photo carousel"} to your inbox</label>
        <div class="tt-details" data-tt-details>
          ${ttPreview}
          <p class="hint">${ttOk.type === "VIDEO"
            ? "TikTok takes no caption for inbox videos; add it in the app."
            : `Title: <strong>${esc(ttOk.title)}</strong>. Caption: ${esc(ttOk.caption.slice(0, 140))}${ttOk.caption.length > 140 ? "..." : ""} <span class="tt-edit">(edit it in the TikTok card; it saves automatically)</span>`}</p>
          <p class="tt-now" role="note"><strong>Sent to your TikTok inbox the moment you approve</strong>${scheduledOthers ? `, even though ${p.facebook_enabled && p.bluesky ? "Facebook and Bluesky are" : p.facebook_enabled ? "Facebook is" : "Bluesky is"} scheduled for ${esc(v.whenText)}` : ""}. Nothing is published on TikTok: you finish and post it in the TikTok app.</p>
          <label><input type="checkbox" name="is_aigc" value="1"> AI-generated content (declared to TikTok)</label>
          <label><input type="checkbox" name="confirm_tiktok" value="1" required data-tt-required> I have the rights to this media and want it sent to TikTok now.</label>
        </div>
      </fieldset>` : ttPlan && !ttPlan.ok && ttPlan.offered ? `<p class="hint tt-blocked">TikTok: ${esc(ttPlan.reason)}</p>` : "";
  const effects = [
    ...(ttOk ? [`<li><strong>Now:</strong> TikTok inbox</li>`] : []),
    ...(fbBs ? [`<li><strong>${p.scheduled_at ? esc(v.whenText) : "Now"}:</strong> ${[p.facebook_enabled ? "Facebook" : "", p.bluesky ? "Bluesky" : ""].filter(Boolean).join(" and ")}</li>`] : []),
  ];
  const buttonText = ttOk && fbBs ? "Approve selected targets" : ttOk ? "Approve and send to TikTok inbox" : p.scheduled_at ? "Approve and schedule" : "Approve and post now";
  const release = canRelease ? `
    <form method="post" action="/post/${id}/approve" class="release-card" id="release-form">
      <input type="hidden" name="csrf" value="${esc(v.csrf)}">
      <input type="hidden" name="expected_updated_at" value="${esc(p.updated_at)}">
      <div class="eyebrow">Release</div>
      <h3>${!fbBs ? "Send to your TikTok inbox" : p.scheduled_at ? "Schedule for " + esc(v.whenText) : "Post as soon as you approve"}</h3>
      ${releaseTargets}
      ${v.releaseProblems.length && fbBs ? `<ul class="checks">${v.releaseProblems.map((x) => `<li class="e">${esc(x)}</li>`).join("")}</ul>` : ""}
      ${p.facebook_enabled && p.images.length > 12 ? `<label><input type="checkbox" name="reviewed_all_images" value="1" required> I reviewed all ${p.images.length} Facebook photos.</label>` : ""}
      ${v.mediaLooksPending ? `<label><input type="checkbox" name="publish_without_media" value="1"> The name says media is pending, but Facebook has none. Publish without media anyway.</label>` : ""}
      ${fbBs && p.scheduled_at ? `<label class="rollover"><input type="checkbox" name="auto_rollover" value="1"> Automatically move to the next valid time if necessary</label>
      <p class="hint">Off: if ${esc(v.whenText)} has become too close, approval is refused and you pick a new time. On: it moves to the earliest valid time and tells you the new time.</p>`
      : p.facebook_enabled && p.images.length ? `<p class="hint">Photo posts go through the upload queue and usually appear on Facebook within a few minutes.</p>` : ""}
      ${ttBlock}
      ${effects.length > 1 ? `<ul class="effects" aria-label="What approving does">${effects.join("")}</ul>` : ""}
      <label for="release-pin">PIN</label>
      <input id="release-pin" type="password" name="pin" inputmode="numeric" autocomplete="off" required>
      <p class="hint release-dirty" id="release-dirty" hidden>Saving your changes. Approval unlocks when they are saved; it releases the saved version.</p>
      <div class="row"><button class="primary" id="release-button">${buttonText}</button></div>
      <p class="rail-note">Releases exactly the saved draft. Each platform's result is shown separately; nothing is retried automatically.</p>
      ${p.instagram ? `<p class="rail-note">Instagram is prepared only and is not released here. Download its photos from the Instagram card.</p>` : ""}
    </form>` : p.tiktok_enabled ? `<div class="release-card"><div class="eyebrow">Release</div><h3>TikTok</h3>
      <p class="hint">${esc(ttPlan && !ttPlan.ok ? ttPlan.reason : "Nothing to release yet.")}</p></div>`
    : `<div class="release-card"><div class="eyebrow">Release</div><h3>Instagram only</h3>
      <p class="hint">Instagram is not connected yet, so there is nothing to approve. Download the finished photos from the Instagram card.</p></div>`;

  return `
<style>
.editor-shell{max-width:1440px;margin:0 auto}
.editor-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);gap:20px;align-items:start}
.editor-rail{position:sticky;top:16px;display:grid;gap:14px}
.editor-head{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin:0 0 14px;font:14px system-ui,sans-serif;color:var(--muted)}
.editor-head strong{font:650 20px/1.25 system-ui,sans-serif;color:var(--text)}
.ed-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:14px}
.ed-card>h3{margin:0 0 12px}
.platform-chips{display:flex;flex-wrap:wrap;gap:8px}
.platform-chip{margin:0!important;padding:10px 14px;border:1px solid var(--line);border-radius:99px;background:var(--bg);cursor:pointer;font:600 14px system-ui,sans-serif!important;align-items:center!important}
.platform-chip:has(input:checked){border-color:var(--accent2);background:color-mix(in srgb,var(--accent2) 15%,var(--panel))}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px}
.tile{margin:0;border:1px solid var(--line);border-radius:10px;padding:6px;background:var(--bg);display:grid;gap:6px}
.tile-frame{position:relative;aspect-ratio:1;border-radius:6px;overflow:hidden;background:repeating-conic-gradient(color-mix(in srgb,var(--line) 55%,transparent) 0 25%,transparent 0 50%) 0 0/14px 14px}
.tile img{width:100%;height:100%;object-fit:contain;display:block}
.tile-ratio{position:absolute;left:5px;bottom:5px;font:600 11px system-ui,sans-serif;padding:2px 6px;border-radius:99px;background:#000b;color:#fff}
.tile-ratio.off{background:var(--warn);color:#1a1307}
.tile-video{grid-column:1/-1;max-width:420px}
.tile-video video{width:100%;max-height:360px;border-radius:6px}
.tile label{margin:0;font-size:12px}
.tile input[type=text]{font-size:13px;padding:7px}
.tile:has(.tile-remove input:checked) img,.tile:has(.tile-remove input:checked) video{opacity:.3}
.tile-remove{color:var(--err)!important}
.adders{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.adder{flex:1 1 220px}
.adder>summary{list-style:none;display:block;text-align:center;font:600 15px system-ui,sans-serif;padding:12px 16px;border:1px dashed var(--accent2);border-radius:10px;color:var(--text)}
.adder>summary::-webkit-details-marker{display:none}
.adder[open]{flex-basis:100%}
.adder[open]>summary{border-style:solid;margin-bottom:12px}
.targets{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:14px;align-items:start;margin-top:12px}
.target{border:1px solid var(--line);border-radius:12px;padding:14px;background:var(--bg);display:grid;gap:8px;min-width:0}
/* A hidden target must not be shown by the author display:grid/flex styles. */
.targets > .target[hidden],.readiness > li[hidden]{display:none!important}
.target[data-state=error]{border-color:var(--err)}
.target-head h4{font:650 16px system-ui,sans-serif;margin:0}
.target-head .format{font:12.5px system-ui,sans-serif;color:var(--muted);margin:2px 0 0}
.target-checks{margin:0;padding:8px 10px 8px 26px;border-radius:8px;background:var(--panel);font-size:13px}
.target-checks .ok{color:var(--ok)}
.target textarea{min-height:140px}
.target .tiles{grid-template-columns:repeat(auto-fill,minmax(110px,1fr))}
.tiles>.hint{grid-column:1/-1}
.cap-label{margin:4px 0 0!important}
.cap-row{display:flex;justify-content:space-between;align-items:end;gap:8px}
.copy-cap{padding:5px 10px;font-size:12px}
.readiness{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:0 0 6px;padding:0;font:13px system-ui,sans-serif}
.readiness li{display:flex;gap:6px;align-items:center;padding:6px 12px;border:1px solid var(--line);border-radius:99px;background:var(--bg)}
.readiness li a{font-weight:650;text-decoration:none}
.readiness [data-ready]{color:var(--ok)}
.readiness li.has-e [data-ready]{color:var(--err)}
.readiness li.has-w [data-ready]{color:var(--warn)}
.ig-frames{border:0;padding:0;margin:4px 0 0;display:flex;flex-wrap:wrap;gap:6px}
.ig-frames legend,.ig-mode legend{font:600 13px system-ui,sans-serif;color:var(--muted);padding:0;margin-bottom:6px}
.seg{display:inline-flex!important;align-items:center;gap:6px;margin:0!important;padding:7px 12px;border:1px solid var(--line);border-radius:99px;background:var(--panel);cursor:pointer;font:600 13px system-ui,sans-serif!important;color:var(--text)!important}
.seg:has(input:checked){border-color:var(--accent2);background:color-mix(in srgb,var(--accent2) 18%,var(--panel))}
.seg:has(input:focus-visible){outline:2px solid var(--accent2);outline-offset:2px}
.ig-bulk{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ig-bulk button,.ig-buttons button{padding:6px 11px;font-size:13px}
.ig-items{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.ig-item{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--panel)}
.ig-item>img{width:72px;height:72px;object-fit:contain;background:#0003;border-radius:6px}
.ig-stage{position:relative;width:100%;max-width:340px;aspect-ratio:4/5;border-radius:6px;overflow:hidden;background:#0003;align-self:start}
.ig-out{width:100%;height:100%;display:block;cursor:grab;touch-action:none}
.ig-out:active{cursor:grabbing}
.ig-out:focus-visible{outline:3px solid var(--accent2);outline-offset:-3px}
.ig-whole{max-width:90px;max-height:90px;border-radius:4px}
.ig-controls{display:grid;gap:8px;align-content:start;min-width:0}
.ig-controls label{margin:0}
.target [hidden]{display:none!important}
.ig-row strong{font:650 14px system-ui,sans-serif}
.ig-mode{border:0;padding:0;margin:0;display:flex;gap:6px;flex-wrap:wrap}
.ig-row{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.ig-zoom input{width:100%}
.ig-pool{grid-template-columns:repeat(auto-fill,minmax(76px,1fr))!important;margin:10px 0}
.ig-add{display:grid;gap:4px;padding:4px;font-size:12px}
.ig-add img{width:100%;aspect-ratio:1;object-fit:contain;background:#0003;border-radius:4px}
.ig-add:disabled{opacity:.45}
.ig-downloads a{white-space:nowrap}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(max-width:520px){.ig-item{grid-template-columns:1fr}}
@media(min-width:1180px){.target-ig{grid-column:span 2}}
.house-title{font:650 14px system-ui,sans-serif;margin:16px 0 0}
.save-bar{position:sticky;bottom:0;z-index:2;display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px;margin-top:6px;background:color-mix(in srgb,var(--panel) 92%,transparent);backdrop-filter:blur(6px);border:1px solid var(--line);border-radius:14px}
.save-bar button{flex:0 0 auto}
.save-state{font:13px system-ui,sans-serif;color:var(--muted)}
.save-state.dirty{color:var(--warn);font-weight:600}
.release-card{background:var(--panel);border:1px solid var(--accent2);border-radius:14px;padding:18px}
.release-card h3{margin:6px 0 10px}
.time-row{display:flex;flex-wrap:wrap;gap:8px}
.tt-release{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:12px 0;display:grid;gap:8px}
.tt-target{font-weight:650!important;color:var(--text)!important;margin:0!important}
.tt-details{display:grid;gap:8px}
.tt-details[hidden]{display:none}
.tt-strip{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px}
.tt-strip img{flex:0 0 52px;width:52px;height:70px;object-fit:cover;border-radius:5px}
.tt-more{align-self:center;font:600 12px system-ui,sans-serif;color:var(--muted)}
.tt-video{width:100%;max-height:220px;border-radius:8px;background:#000}
.tt-now{margin:0;padding:8px 10px;border-left:3px solid var(--warn);background:color-mix(in srgb,var(--warn) 12%,var(--panel));font:13px system-ui,sans-serif}
.tt-edit{color:var(--muted)}
.effects{list-style:none;margin:8px 0 0;padding:0;font:13px system-ui,sans-serif;display:grid;gap:2px}
.tile-move{display:flex;align-items:center;gap:4px}
.tile[draggable=true]{cursor:grab}
.tile.dragging,.ig-item.dragging{opacity:.45}
.tile.drop-target,.ig-item.drop-target{outline:2px dashed var(--accent2);outline-offset:2px}
.ig-drag{cursor:grab;user-select:none;border:1px dashed var(--line);border-radius:6px;padding:4px 7px;font:600 12px system-ui,sans-serif}
.tile-move button{padding:2px 9px;font-size:15px;line-height:1.2}
.tile-move button:disabled{opacity:.35}
.tile-pos{font:650 12px system-ui,sans-serif;color:var(--muted);margin-right:auto}
.mode-line{font:13px system-ui,sans-serif;color:var(--muted);margin:-6px 0 14px}
.rollover{font-weight:600!important;color:var(--text)!important}
.save-state.failed{color:var(--err);font-weight:600}
.time-row input{flex:1 1 210px}
.time-row button{padding:9px 12px;font-size:13px}
@media(max-width:860px){.editor-grid{grid-template-columns:1fr}.editor-rail{position:static}}
@media(max-width:600px){.tiles{grid-template-columns:repeat(auto-fill,minmax(96px,1fr))}}
</style>
<div class="editor-shell">
  <p><a href="/">← All posts and calendar</a></p>
  ${v.error ? `<div class="notice err" role="alert">${esc(v.error)}</div>` : ""}
  ${v.notice ? `<div class="notice ok" role="status">${esc(v.notice)}</div>` : ""}
  ${p.status === "rejected" && p.note ? `<div class="notice">Your note for the drafting assistant: ${esc(p.note)}</div>` : ""}
  <div class="editor-head"><span class="chip s-${esc(p.status)}">${esc(p.status)}</span><strong>${esc(p.label || "Untitled draft")}</strong>${p.release ? `<span>${esc(p.release)}</span>` : ""}<span>${esc(v.whenText)}</span></div>
  <p class="mode-line">Draft. Changes save automatically. Nothing is published until you approve with your PIN.</p>
  <div class="editor-grid">
  <form method="post" action="/post/${id}/save" id="draft-editor">
    <input type="hidden" name="csrf" value="${esc(v.csrf)}">
    <input type="hidden" name="expected_updated_at" value="${esc(p.updated_at)}">

    <section class="ed-card" aria-labelledby="ed-platforms">
      <h3 id="ed-platforms">Platforms</h3>
      <div class="platform-chips">
        ${chip("p_facebook", "Facebook", p.facebook_enabled)}
        ${chip("p_instagram", "Instagram", !!p.instagram)}
        ${chip("p_bluesky", "Bluesky", !!p.bluesky)}
        ${chip("p_tiktok", "TikTok", !!p.tiktok_enabled)}
      </div>
      <p class="hint">Unchecked platforms are hidden and excluded from approval. Their saved captions, images and settings are retained when you turn them off.</p>
    </section>

    <section class="ed-card targets-card" aria-labelledby="ed-targets">
      <h3 id="ed-targets">Each platform</h3>
      <ol class="readiness" id="ed-readiness" aria-label="Readiness by platform">
        ${PLATFORM_ORDER.map((pid) => `<li data-platform="${pid}"${hide(on[pid])}><a href="#target-${pid}">${esc(PLATFORMS[pid].label)}</a>
          <span data-ready="${pid}">${(() => { const c = checkTarget(states[pid]); return c.errors.length ? c.errors.length + (c.errors.length === 1 ? " problem" : " problems") : c.warnings.length ? "Ready, " + c.warnings.length + (c.warnings.length === 1 ? " note" : " notes") : "Ready"; })()}</span></li>`).join("")}
      </ol>
      <p class="hint">Thumbnails show the whole picture. They are not the crop a platform will deliver; the notes under each platform say what it does with other shapes.</p>
      <div class="targets" data-rules="${esc(platformRulesJson())}">
        <article class="target" id="target-facebook" data-platform="facebook"${hide(on.facebook)} aria-labelledby="tg-facebook">
          <div class="target-head"><h4 id="tg-facebook">Facebook</h4><p class="format">${esc(formatLine("facebook"))}</p></div>
          <ul class="checks target-checks" data-checks="facebook">${checkItems(states.facebook)}</ul>
          <label for="ed-message" class="cap-label">Caption</label>
          <textarea id="ed-message" name="message" maxlength="${FB_MAX}" data-max="${FB_MAX}" data-caption="facebook">${esc(p.message)}</textarea>
          <div class="field-meter"></div>
          <div class="tiles" data-media="facebook" data-order="order_fb">${fbMedia || empty}</div>
          ${!p.video && p.images.length > 1 ? `<input type="hidden" name="order_fb" value="${Array.from({ length: p.images.length }, (_, i) => i).join(",")}">` : ""}
        </article>
        <article class="target target-ig" id="target-instagram" data-platform="instagram"${hide(on.instagram)} aria-labelledby="tg-instagram">
          <div class="target-head"><h4 id="tg-instagram">Instagram</h4><p class="format">${esc(formatLine("instagram"))}</p></div>
          <ul class="checks target-checks" data-checks="instagram">${checkItems(states.instagram)}</ul>
          <fieldset class="ig-frames"><legend>Frame for every photo</legend>
            ${INSTAGRAM_FRAMES.map((f) => `<label class="seg"><input type="radio" name="ig_frame" value="${f}"${f === igFrame ? " checked" : ""}> ${f === "4:5" ? "Portrait 4:5" : f === "1:1" ? "Square 1:1" : "Landscape 1.91:1"}</label>`).join("")}
          </fieldset>
          <div class="ig-bulk"><span class="hint">All photos:</span>
            <button type="button" data-ig-all="crop">Crop all</button><button type="button" data-ig-all="pad">Pad all</button></div>
          <div class="cap-row"><label for="ed-ig" class="cap-label">Caption</label>
            <button type="button" class="copy-cap" data-copy-to="ed-ig" data-copy-from="ed-message">Copy Facebook caption</button></div>
          <textarea id="ed-ig" name="ig_caption" maxlength="${INSTAGRAM_CAPTION_MAX}" data-max="${INSTAGRAM_CAPTION_MAX}" data-caption="instagram" placeholder="Instagram caption; links are not clickable here">${esc(ig?.caption ?? "")}</textarea>
          <div class="field-meter"></div>
          <label for="ig-video-source" class="cap-label">Reel video from this post (optional)</label>
          <select name="ig_video_source" id="ig-video-source">
            <option value="">Photo carousel, not a video</option>
            ${availableVideos.map((url,i)=>`<option value="${esc(url)}"${igVideo===url?" selected":""}>Video ${i+1} from this post</option>`).join("")}
          </select>
          <p class="hint">Choose a video to prepare a Reel, or use the photos below. Switching to a video clears the Instagram photo selection after confirmation. You can also upload an Instagram-only MP4 in Add video.</p>
          <div id="ig-reel-panel">
            <video id="ig-reel-preview" controls playsinline preload="metadata" style="max-width:100%;max-height:440px" src="/video/${p.id}/instagram"${ig?.video?"":" hidden"}></video>
            <p class="hint" id="ig-reel-specs">Reels work best at 9:16 with H.264 video and Advanced Audio Coding audio. GS Poster does not transcode or crop video. Verify the source before posting in Instagram.</p>
            <p><a id="ig-reel-download" href="/instagram/${p.id}/video.mp4" download="instagram-${p.id}-reel.mp4"${ig?.video?"":" hidden"}>Download MP4 for Instagram Reel</a></p>
          </div>
          <input type="hidden" name="ig_items" id="ig-items-field" value="${esc(JSON.stringify(igItems))}">
          <ol class="ig-items" id="ig-items" data-media="instagram" data-post="${id}" data-saved="${esc(JSON.stringify(igItems))}"
            data-pool="${esc(JSON.stringify(pool.map((url, i) => ({ url, src: `/media/${p.id}/${i}?platform=pool` }))))}"
            data-max="${INSTAGRAM_MAX_ITEMS}" data-max-zoom="${INSTAGRAM_MAX_ZOOM}" data-bgs="${esc(JSON.stringify(INSTAGRAM_BACKGROUNDS))}">
            ${igItems.map((it, n) => `<li class="ig-item"><img src="/media/${p.id}/${pool.indexOf(it.url)}?platform=pool" alt="Instagram photo ${n + 1}">
              <span>${it.mode === "crop" ? "Cropped" : "Padded"} · <a href="/instagram/${p.id}/${n}.jpg" download>Download</a></span></li>`).join("")}
          </ol>
          ${pool.length ? `<details class="ig-picker" id="ig-picker"${igItems.length ? "" : " open"}><summary>Add photos from this post</summary>
            <div class="tiles ig-pool" id="ig-pool">${pool.map((url, i) => `<button type="button" class="ig-add" data-url="${esc(url)}"><img loading="lazy" src="/media/${p.id}/${i}?platform=pool" alt="Add photo ${i + 1}"><span>Add</span></button>`).join("")}</div>
            <button type="button" id="ig-add-all">Add all, in this order</button>
          </details>` : `<p class="hint">Add photos to the post first; Instagram picks from them.</p>`}
          ${on.instagram && igVideo && parseGitHubUrl(igVideo) ? `<div class="row"><button type="button" data-prepare-video="instagram">Prepare Instagram video privately</button></div>` : ""}
          <p class="hint" id="ig-unsaved" hidden>Save to download prepared Instagram media.</p>
          <p class="hint ig-downloads" id="ig-downloads"${igItems.length ? "" : " hidden"}>${esc(PLATFORMS.instagram.delivery)}
            ${igItems.map((_, n) => `<a href="/instagram/${p.id}/${n}.jpg" download="instagram-${p.id}-${n + 1}.jpg">Photo ${n + 1}</a>`).join(" · ")}</p>
        </article>
        <article class="target" id="target-bluesky" data-platform="bluesky"${hide(on.bluesky)} aria-labelledby="tg-bluesky">
          <div class="target-head"><h4 id="tg-bluesky">Bluesky</h4><p class="format">${esc(formatLine("bluesky"))}</p></div>
          <ul class="checks target-checks" data-checks="bluesky">${checkItems(states.bluesky)}</ul>
          <div class="cap-row"><label for="ed-bs" class="cap-label">Caption</label>
            <button type="button" class="copy-cap" data-copy-to="ed-bs" data-copy-from="ed-message">Copy Facebook caption</button></div>
          <textarea id="ed-bs" name="bs_caption" data-max="${BSKY_TEXT_LIMIT}" data-graphemes="1" data-caption="bluesky" placeholder="A short companion caption">${esc(bs?.caption ?? "")}</textarea>
          <div class="field-meter"></div>
          ${p.video ? `<div class="row"><button type="button" id="bs-copy-fb-video">Use Facebook video for Bluesky</button><input type="hidden" name="bs_copy_fb_video" id="bs-copy-fb-video-flag" value="0"></div><label for="bs-copy-video-alt">Video description for Bluesky when copying<input id="bs-copy-video-alt" type="text" name="bs_copy_video_alt" maxlength="1000" value="${esc(bs?.video?.alt??"")}" placeholder="Describe the action in the video"></label>` : ""}
          <div class="tiles" data-media="bluesky" data-order="order_bs">${bsMedia || empty}</div>
          ${on.bluesky && bs?.video?.url && parseGitHubUrl(bs.video.url) ? `<div class="row"><button type="button" data-prepare-video="bluesky">Prepare Bluesky video privately</button></div>` : ""}
          ${bs && !bs.video && bs.images.length > 1 ? `<input type="hidden" name="order_bs" value="${Array.from({ length: bs.images.length }, (_, i) => i).join(",")}">` : ""}
          <details${bs?.patreon ? " open" : ""}><summary>Patreon link card (optional)</summary>
            <label for="ed-patreon-url">Free Patreon post URL</label>
            <input id="ed-patreon-url" type="text" name="bs_patreon_url" value="${esc(bs?.patreon?.url ?? "")}" placeholder="https://www.patreon.com/posts/...">
            <label for="ed-patreon-title">Card title</label>
            <input id="ed-patreon-title" type="text" name="bs_patreon_title" value="${esc(bs?.patreon?.title ?? "")}">
            <label for="ed-patreon-desc">Card description</label>
            <input id="ed-patreon-desc" type="text" name="bs_patreon_description" value="${esc(bs?.patreon?.description ?? "")}">
          </details>
        </article>
        <article class="target" id="target-tiktok" data-platform="tiktok"${hide(on.tiktok)} aria-labelledby="tg-tiktok"${ttShared ? ' data-shared="facebook"' : ""}>
          <div class="target-head"><h4 id="tg-tiktok">TikTok</h4><p class="format">${esc(formatLine("tiktok"))}</p></div>
          <ul class="checks target-checks" data-checks="tiktok">${checkItems(states.tiktok)}</ul>
          <label for="ed-tiktok-title" class="cap-label">Public carousel title (required for TikTok photos)</label>
          <input id="ed-tiktok-title" type="text" name="tiktok_title" maxlength="90" value="${esc(p.tiktok_title ?? "")}" placeholder="The title viewers see, not the internal draft name">
          <div class="cap-row"><label for="ed-tiktok" class="cap-label">Caption</label>
            <button type="button" class="copy-cap" data-copy-to="ed-tiktok" data-copy-from="ed-message">Copy Facebook caption</button></div>
          <textarea id="ed-tiktok" name="tiktok_caption" data-max="${captionLimit("tiktok", { photos: 1, video: !!(ttShared ? p.video : tt.video) })}" data-caption="tiktok" placeholder="Leave empty to reuse the Facebook caption">${esc(p.tiktok_caption ?? "")}</textarea>
          <div class="field-meter"></div>
          ${p.images.length ? `<div class="row"><button type="button" id="tt-copy-fb">Use Facebook photos for TikTok</button><input type="hidden" name="tt_copy_fb" id="tt-copy-fb-flag" value="0"></div>
          <p class="hint">Replaces TikTok media with a separate copy of the Facebook gallery. After saving, prepare any linked GitHub photos for TikTok using the action below.</p>` : ""}
          <div class="tiles" data-media="tiktok" data-order="order_tt">${ttMedia || empty}</div>
          ${on.tiktok && !ttShared && tt.video && parseGitHubUrl(tt.video) ? `<div class="row"><button type="button" data-prepare-video="tiktok">Prepare TikTok video privately</button></div>` : ""}
          ${p.tiktok_enabled && ttImportIndices.length ? `<div class="row"><button type="button" id="tt-import" data-indices="${esc(JSON.stringify(ttImportIndices))}">Prepare ${ttImportIndices.length} linked photo${ttImportIndices.length === 1 ? "" : "s"} for TikTok</button></div>
          <p class="hint" id="tt-import-status" role="status" aria-live="polite">Copies only the linked TikTok photos into private storage. Facebook originals stay unchanged. Prepare them close to publication; private copies expire after 45 days.</p>` : ""}
          ${!ttShared && !tt.video && tt.images.length > 1 ? `<input type="hidden" name="order_tt" value="${Array.from({ length: tt.images.length }, (_, i) => i).join(",")}">` : ""}
          <p class="hint">${esc(PLATFORMS.tiktok.delivery)}</p>
        </article>
      </div>
      ${v.checksHtml ? `<h4 class="house-title">House rules</h4><ul class="checks">${v.checksHtml}</ul>` : ""}
    </section>

    <section class="ed-card" aria-labelledby="ed-media">
      <h3 id="ed-media">Add photos and video</h3>
      ${v.mediaPanel}
    </section>

    <section class="ed-card" aria-labelledby="ed-details">
      <h3 id="ed-details">Name and time</h3>
      <label for="ed-label">Post name</label>
      <input id="ed-label" type="text" name="label" maxlength="120" value="${esc(p.label ?? "")}" placeholder="Goblin NPC gallery">
      <label for="ed-release">Release or collection</label>
      <input id="ed-release" type="text" name="release" maxlength="120" value="${esc(p.release ?? "")}">
      <label for="ed-when">Publish time (${esc(v.tz)})</label>
      <div class="time-row">
        <input id="ed-when" type="datetime-local" name="when" value="${esc(when)}">
        <button type="button" id="ed-now">Post now</button>
        <button type="button" id="ed-earliest">Earliest valid time</button>
      </div>
      <p class="hint" id="ed-time-hint">"Post now" leaves the time empty: it goes out when you approve. "Earliest valid time" asks the server for the first time that will still be valid in about ten minutes. At approval a scheduled post must be at least 12 minutes ahead, 30 for Facebook photo posts (they go through the upload queue).</p>
    </section>

    <div class="save-bar">
      <button class="primary" type="submit" id="ed-save">Save changes</button>
      <span class="save-state" id="ed-state" role="status" aria-live="polite">All changes saved</span>
      <span class="hint">Saves automatically.</span>
    </div>
    <p class="hint">${esc(v.createdLine)}</p>
  </form>
  <aside class="editor-rail" aria-label="Release">
    ${release}
    ${v.tiktokCard}
    <details class="ed-card"><summary>Reject and send back to the assistant</summary>
      <form method="post" action="/post/${id}/reject">
        <input type="hidden" name="csrf" value="${esc(v.csrf)}">
        <label for="reason">What should change? (optional)</label>
        <input id="reason" type="text" name="reason" maxlength="500">
        <div class="row"><button class="danger">Reject</button></div>
      </form>
    </details>
  </aside>
  </div>
</div>
<script src="/draft-editor.js" defer></script>`;
}

/** Client behaviour: platform toggles, counters, dirty tracking and quick times. */
export const DRAFT_EDITOR_JS = INSTAGRAM_PLAN_JS + String.raw`
(() => {
  const form = document.getElementById("draft-editor");
  if (!form) return;
  const state = document.getElementById("ed-state");
  const releaseBtn = document.getElementById("release-button");
  const releaseNote = document.getElementById("release-dirty");
  // The version and CSRF fields change on every save; they are not edits.
  const entries = () => Array.from(new FormData(form).entries())
    .filter(([k]) => k !== "expected_updated_at" && k !== "csrf").map(([k, v]) => [k, String(v)]);
  const snapshot = () => JSON.stringify(entries());
  let baseline = snapshot();
  let submitting = false;
  let saveState = "";
  const dirty = () => snapshot() !== baseline;
  window.gsEditorDirty = dirty;
  function refresh() {
    const d = dirty();
    state.textContent = saveState || (d ? "Unsaved changes" : "All changes saved");
    state.classList.toggle("dirty", d && !saveState.startsWith("Save failed"));
    state.classList.toggle("failed", saveState.startsWith("Save failed"));
    if (releaseBtn) releaseBtn.disabled = d;
    if (releaseNote) releaseNote.hidden = !d;
    // A frame, caption or other unsaved editor change also makes the saved
    // Instagram JPEG links stale, not just a change to the photo list.
    const igField = document.getElementById("ig-items-field");
    const hasIgPhotos = !!igField && igField.value !== "[]";
    const igDownloads = document.getElementById("ig-downloads");
    if (igDownloads) igDownloads.hidden = d || !hasIgPhotos;
    const igHasVideo = !!document.getElementById("ig-video-source")?.value;
    const igReelDownload = document.getElementById("ig-reel-download");
    if(igReelDownload)igReelDownload.hidden=d||!igHasVideo;
    const igPreview=document.getElementById("ig-reel-preview");
    if(igPreview)igPreview.hidden=d||!igHasVideo;
    const igUnsaved = document.getElementById("ig-unsaved");
    if (igUnsaved) igUnsaved.hidden = !d || (!hasIgPhotos && !igHasVideo);
  }
  function togglePlatform(box) {
    const name = box.dataset.platformToggle;
    form.querySelectorAll('[data-platform="' + name + '"]').forEach(el => { el.hidden = !box.checked; });
  }
  form.querySelectorAll("[data-platform-toggle]").forEach(box => box.addEventListener("change", () => togglePlatform(box)));
  document.getElementById("bs-copy-fb-video")?.addEventListener("click",()=>{
    if(!confirm("Replace Bluesky photos or video with the existing Facebook video?"))return;
    const field=document.getElementById("bs-copy-fb-video-flag");
    field.value="1";field.dispatchEvent(new Event("input",{bubbles:true}));
  });
  document.getElementById("tt-copy-fb")?.addEventListener("click", () => {
    if (!confirm("Replace the TikTok gallery with a separate copy of the Facebook photos?")) return;
    const field = document.getElementById("tt-copy-fb-flag");
    field.value = "1";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  function meter(area) {
    const out = area.parentElement.querySelector(".field-meter");
    if (!out) return;
    const max = Number(area.dataset.max || 0);
    const n = area.dataset.graphemes && typeof Intl !== "undefined" && Intl.Segmenter
      ? Array.from(new Intl.Segmenter().segment(area.value)).length : area.value.length;
    out.textContent = n + " / " + max;
    out.style.color = n > max ? "var(--err)" : "";
  }
  form.querySelectorAll("textarea[data-max]").forEach(a => { meter(a); a.addEventListener("input", () => meter(a)); });

  // Per-platform live checks. Mirrors checkTarget() in src/platforms.ts; the
  // rules come from the server so both use the same numbers.
  const targetsEl = form.querySelector(".targets");
  let igApi = null;
  let rules = {};
  try { rules = JSON.parse(targetsEl?.dataset.rules || "{}"); } catch {}
  const seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter() : null;
  const glen = t => seg ? Array.from(seg.segment(t)).length : Array.from(t).length;
  const NAMED = [[1,"1:1"],[0.8,"4:5"],[0.75,"3:4"],[2/3,"2:3"],[0.5625,"9:16"],[1.25,"5:4"],[4/3,"4:3"],[1.5,"3:2"],[1.91,"1.91:1"],[16/9,"16:9"]];
  const ratioLabel = r => { const n = NAMED.find(([x]) => Math.abs(x - r) / x < 0.025); return n ? n[1] : r.toFixed(2) + ":1"; };
  const kept = box => box ? Array.from(box.querySelectorAll("[data-tile]")).filter(t => !t.querySelector(".tile-remove input")?.checked) : [];
  function mediaBox(card) {
    const shared = card.dataset.shared;
    return shared ? form.querySelector('[data-media="' + shared + '"]') : card.querySelector("[data-media]");
  }
  function captionLimit(r, st) { return st.video ? r.caption.video : st.photos ? r.caption.photo : r.caption.text; }
  function stateOf(id, card) {
    const r = rules[id];
    if (id === "instagram" && igApi) {
      const text = card.querySelector("[data-caption]")?.value || "";
      return { photos: igApi.items.length, video: !!document.getElementById("ig-video-source")?.value, captionLength: text.length, missingAlt: 0, ratios: [],
        hashtags: (text.match(/(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu) || []).length, lowRes: igApi.lowRes() };
    }
    const tiles = kept(mediaBox(card));
    const photos = tiles.filter(t => t.dataset.tile === "photo");
    let text = card.querySelector("[data-caption]")?.value || "";
    if (id === "tiktok" && !text.trim()) text = document.getElementById("ed-message")?.value || "";
    return {
      photos: photos.length, video: tiles.some(t => t.dataset.tile === "video"),
      captionLength: r.graphemes ? glen(text) : text.length,
      missingAlt: r.altRequired ? tiles.filter(t => { const i = t.querySelector('input[type="text"]'); return i && !i.value.trim(); }).length : 0,
      ratios: photos.map(t => Number(t.dataset.ratio)).filter(x => x > 0),
    };
  }
  function checkTarget(r, st) {
    const errors = [], warnings = [];
    const limit = captionLimit(r, st);
    if (st.photos && st.video && !r.mixPhotoVideo) errors.push("Photos and a video cannot go in the same post.");
    if (st.photos > r.maxPhotos) errors.push(st.photos + " photos; " + r.label + " allows " + r.maxPhotos + ".");
    if (!st.photos && !st.video && !r.textOnly) errors.push(r.label + " needs photos or a video.");
    if (limit && st.captionLength > limit) errors.push("Caption is " + st.captionLength + " characters; " + r.label + " allows " + limit + ".");
    if (r.altRequired && st.missingAlt) errors.push(st.missingAlt + (st.missingAlt === 1 ? " description is" : " descriptions are") + " missing.");
    if (r.maxHashtags && (st.hashtags || 0) > r.maxHashtags) errors.push(st.hashtags + " hashtags; " + r.label + " allows " + r.maxHashtags + ".");
    if (!st.captionLength && r.id !== "tiktok") warnings.push("Caption is empty.");
    if (st.lowRes) warnings.push(st.lowRes + (st.lowRes === 1 ? " photo is" : " photos are") + " enlarged to fit and may look soft.");
    const off = r.framed ? 0 : st.ratios.filter(x => x < r.aspect.min - 0.01 || x > r.aspect.max + 0.01).length;
    if (off) warnings.push(off + (off === 1 ? " photo is" : " photos are") + " outside " + r.aspect.label + ". " + r.aspect.outside);
    return { errors, warnings, limit };
  }
  function paintBadges(id, card) {
    const r = rules[id];
    const box = mediaBox(card);
    if (!r || !box || card.dataset.shared) return;
    box.querySelectorAll('[data-tile="photo"]').forEach(t => {
      const b = t.querySelector("[data-ratio-badge]"), x = Number(t.dataset.ratio);
      if (!b || !x) return;
      b.hidden = false;
      b.textContent = ratioLabel(x);
      const off = x < r.aspect.min - 0.01 || x > r.aspect.max + 0.01;
      b.classList.toggle("off", off);
      b.title = off ? r.aspect.outside : "Shows uncropped on " + r.label;
    });
  }
  function recheck() {
    form.querySelectorAll(".target[data-platform]").forEach(card => {
      const id = card.dataset.platform, r = rules[id];
      if (!r) return;
      const st = stateOf(id, card), c = checkTarget(r, st);
      const list = card.querySelector("[data-checks]");
      if (list) {
        list.replaceChildren(...(c.errors.length || c.warnings.length
          ? [...c.errors.map(t => [t, "e"]), ...c.warnings.map(t => [t, "w"])]
          : [["Ready for " + r.label + ".", "ok"]]).map(([t, k]) => { const li = document.createElement("li"); li.className = k; li.textContent = t; return li; }));
      }
      card.dataset.state = c.errors.length ? "error" : c.warnings.length ? "warn" : "ok";
      const area = card.querySelector("textarea[data-caption]");
      if (area && c.limit && id !== "facebook") { area.dataset.max = String(c.limit); meter(area); }
      const pill = form.querySelector('[data-ready="' + id + '"]');
      if (pill) {
        pill.textContent = c.errors.length ? c.errors.length + (c.errors.length === 1 ? " problem" : " problems")
          : c.warnings.length ? "Ready, " + c.warnings.length + (c.warnings.length === 1 ? " note" : " notes") : "Ready";
        pill.parentElement.classList.toggle("has-e", !!c.errors.length);
        pill.parentElement.classList.toggle("has-w", !c.errors.length && !!c.warnings.length);
      }
      paintBadges(id, card);
    });
  }
  form.querySelectorAll('[data-tile="photo"] img').forEach(img => {
    const set = () => { if (img.naturalWidth && img.naturalHeight) { img.closest("[data-tile]").dataset.ratio = String(img.naturalWidth / img.naturalHeight); recheck(); } };
    if (img.complete) set(); else img.addEventListener("load", set, { once: true });
  });
  form.querySelectorAll(".copy-cap").forEach(btn => btn.addEventListener("click", () => {
    const to = document.getElementById(btn.dataset.copyTo), from = document.getElementById(btn.dataset.copyFrom);
    if (!to || !from) return;
    if (to.value.trim() && to.value !== from.value && !confirm("Replace this caption with the Facebook caption?")) return;
    to.value = from.value;
    to.dispatchEvent(new Event("input", { bubbles: true }));
    to.focus();
  }));

  // Instagram: one frame for the carousel, each photo cropped or padded.
  // The preview uses instagramPlan(), the same function the server renders with.
  const igList = document.getElementById("ig-items");
  const igField = document.getElementById("ig-items-field");
  if (igList && igField) {
    const SIZES = { "4:5": [1080, 1350], "1:1": [1080, 1080], "1.91:1": [1080, 566] };
    let pool = [], BGS = {};
    try { pool = JSON.parse(igList.dataset.pool || "[]"); BGS = JSON.parse(igList.dataset.bgs || "{}"); } catch {}
    const MAXZ = Number(igList.dataset.maxZoom || 4), MAX = Number(igList.dataset.max || 10);
    let savedValue = igField.value;
    let items = [];
    try { items = JSON.parse(igField.value || "[]"); } catch {}
    const srcOf = url => (pool.find(x => x.url === url) || {}).src || "";
    const frame = () => (form.querySelector('input[name="ig_frame"]:checked') || {}).value || "4:5";
    const imgs = new Map();
    let uid = 0;
    function load(url) {
      if (!imgs.has(url)) {
        const im = new Image();
        im.addEventListener("load", () => { igList.querySelectorAll("li").forEach(li => li.dataset.url === url && draw(li)); recheck(); });
        im.src = srcOf(url);
        imgs.set(url, im);
      }
      return imgs.get(url);
    }
    function sync() {
      igField.value = JSON.stringify(items);
      const dl = document.getElementById("ig-downloads");
      if (dl) dl.hidden = igField.value !== savedValue || !items.length;
      const note = document.getElementById("ig-unsaved");
      if (note) note.hidden = igField.value === savedValue;
      igField.dispatchEvent(new Event("input", { bubbles: true }));
    }
    function planFor(li) {
      const it = items[Number(li.dataset.index)], im = load(it.url);
      if (!im.naturalWidth) return null;
      return instagramPlan(im.naturalWidth, im.naturalHeight, frame(), it.mode, it.cx, it.cy, it.zoom);
    }
    function draw(li) {
      const it = items[Number(li.dataset.index)];
      if (!it) return;
      const [W, H] = SIZES[frame()] || SIZES["4:5"];
      const cv = li.querySelector(".ig-out"), whole = li.querySelector(".ig-whole");
      const k = 420 / W;
      cv.width = Math.round(W * k); cv.height = Math.round(H * k);
      const ctx = cv.getContext("2d");
      ctx.fillStyle = BGS[it.bg] || "#000";
      ctx.fillRect(0, 0, cv.width, cv.height);
      const warn = li.querySelector("[data-ig-warn]");
      const im = load(it.url), p = planFor(li);
      li.dataset.lowres = "";
      if (!p) { warn.textContent = "Loading photo..."; return; }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(im, p.src.x, p.src.y, p.src.w, p.src.h, p.dst.x * k, p.dst.y * k, p.dst.w * k, p.dst.h * k);
      const enlarge = p.dst.w / p.src.w;
      li.dataset.lowres = enlarge > 1.05 ? "1" : "";
      warn.textContent = enlarge > 1.05
        ? "Enlarged " + enlarge.toFixed(1) + " times (" + p.src.w + " px of the original fill " + p.dst.w + " px). It may look soft."
        : it.mode === "crop" ? p.src.w + " x " + p.src.h + " px of " + im.naturalWidth + " x " + im.naturalHeight + " kept." : "Whole picture kept.";
      // The small view shows the whole original and the part that is kept.
      const wk = Math.min(150 / im.naturalWidth, 150 / im.naturalHeight);
      whole.width = Math.round(im.naturalWidth * wk); whole.height = Math.round(im.naturalHeight * wk);
      const wc = whole.getContext("2d");
      wc.drawImage(im, 0, 0, whole.width, whole.height);
      if (it.mode === "crop") {
        wc.fillStyle = "rgba(0,0,0,.55)";
        const x = p.src.x * wk, y = p.src.y * wk, w = p.src.w * wk, h = p.src.h * wk;
        wc.fillRect(0, 0, whole.width, y); wc.fillRect(0, y + h, whole.width, whole.height - y - h);
        wc.fillRect(0, y, x, h); wc.fillRect(x + w, y, whole.width - x - w, h);
        wc.strokeStyle = "#d8b25a"; wc.lineWidth = 2; wc.strokeRect(x + 1, y + 1, w - 2, h - 2);
      }
      li.querySelector(".ig-stage").style.aspectRatio = W + " / " + H;
    }
    function el(tag, attrs, html) { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }
    function render() {
      igList.replaceChildren();
      items.forEach((it, n) => {
        const id = "ig" + (uid++);
        const li = el("li", { class: "ig-item", "data-tile": "photo", "data-index": String(n) });
        li.dataset.url = it.url;
        li.innerHTML =
          '<div class="ig-stage"><canvas class="ig-out" tabindex="0" role="img"></canvas></div>' +
          '<div class="ig-controls">' +
          '<div class="ig-row"><strong>Photo ' + (n + 1) + '</strong><span class="ig-drag" draggable="true" title="Drag to reorder; up and down buttons also work">Drag to reorder</span><canvas class="ig-whole" aria-hidden="true"></canvas></div>' +
          '<fieldset class="ig-mode"><legend class="sr-only">How to fit photo ' + (n + 1) + '</legend>' +
          '<label class="seg"><input type="radio" form="ig-detached" name="' + id + '" value="crop"> Crop</label>' +
          '<label class="seg"><input type="radio" form="ig-detached" name="' + id + '" value="pad"> Pad</label></fieldset>' +
          '<label class="ig-zoom">Zoom <input type="range" form="ig-detached" min="1" max="' + MAXZ + '" step="0.05"></label>' +
          '<label class="ig-bg">Background <select form="ig-detached"></select></label>' +
          '<p class="hint" data-ig-warn></p>' +
          '<div class="ig-row ig-buttons">' +
          '<button type="button" data-act="up" aria-label="Move photo ' + (n + 1) + ' earlier">&#8593;</button>' +
          '<button type="button" data-act="down" aria-label="Move photo ' + (n + 1) + ' later">&#8595;</button>' +
          '<button type="button" data-act="reset">Centre</button>' +
          '<button type="button" data-act="remove" class="danger">Remove</button></div></div>';
        const cv = li.querySelector(".ig-out");
        cv.setAttribute("aria-label", "Instagram photo " + (n + 1) + " as it will look. " + (it.mode === "crop" ? "Drag, or use the arrow keys, to choose the part to keep; plus and minus zoom." : "Padded: the whole picture is kept."));
        li.querySelector('input[value="' + it.mode + '"]').checked = true;
        const zoom = li.querySelector('input[type="range"]');
        zoom.value = String(it.zoom);
        const sel = li.querySelector("select");
        for (const name in BGS) { const o = el("option", { value: name }, name.charAt(0).toUpperCase() + name.slice(1)); if (name === it.bg) o.selected = true; sel.append(o); }
        li.querySelector(".ig-zoom").hidden = it.mode !== "crop";
        li.querySelector(".ig-bg").hidden = it.mode !== "pad";
        li.querySelector('[data-act="reset"]').hidden = it.mode !== "crop";
        li.querySelector('[data-act="up"]').disabled = n === 0;
        li.querySelector('[data-act="down"]').disabled = n === items.length - 1;
        igList.append(li);
        draw(li);
      });
      igList.parentElement.querySelectorAll(".ig-add").forEach(b => {
        const used = items.some(x => x.url === b.dataset.url);
        b.disabled = used || items.length >= MAX;
        b.querySelector("span").textContent = used ? "Added" : "Add";
      });
      sync();
      recheck();
    }
    // Photo handles reorder the carousel; the crop canvas retains its own
    // pointer drag behavior. Arrow buttons remain the keyboard alternative.
    let igDrag = -1;
    igList.addEventListener("dragstart", e => {
      const handle = e.target.closest(".ig-drag");
      if (!handle) { e.preventDefault(); return; }
      igDrag = Number(handle.closest(".ig-item").dataset.index);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "instagram-photo");
      handle.closest(".ig-item").classList.add("dragging");
    });
    igList.addEventListener("dragover", e => {
      if (igDrag < 0) return;
      const li = e.target.closest(".ig-item");
      if (!li) return;
      e.preventDefault();
      igList.querySelectorAll(".drop-target").forEach(x => x.classList.remove("drop-target"));
      li.classList.add("drop-target");
    });
    igList.addEventListener("drop", e => {
      if (igDrag < 0) return;
      const li = e.target.closest(".ig-item");
      if (!li) return;
      e.preventDefault();
      const from = igDrag, to = Number(li.dataset.index);
      igDrag = -1;
      if (from !== to) { const moved = items.splice(from, 1)[0]; items.splice(to, 0, moved); render(); }
      igList.querySelectorAll(".dragging,.drop-target").forEach(x => x.classList.remove("dragging", "drop-target"));
    });
    igList.addEventListener("dragend", () => { igDrag = -1; igList.querySelectorAll(".dragging,.drop-target").forEach(x => x.classList.remove("dragging", "drop-target")); });
    function itemOf(target) { const li = target.closest(".ig-item"); return li ? [li, items[Number(li.dataset.index)]] : [null, null]; }
    igList.addEventListener("change", e => {
      const [li, it] = itemOf(e.target);
      if (!it) return;
      if (e.target.type === "radio") { it.mode = e.target.value; render(); return; }
      if (e.target.tagName === "SELECT") { it.bg = e.target.value; draw(li); sync(); }
    });
    igList.addEventListener("input", e => {
      const [li, it] = itemOf(e.target);
      if (it && e.target.type === "range") { it.zoom = Number(e.target.value); draw(li); sync(); }
    });
    igList.addEventListener("click", e => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      const [, it] = itemOf(b), n = items.indexOf(it);
      if (b.dataset.act === "remove") items.splice(n, 1);
      if (b.dataset.act === "up" && n > 0) items.splice(n - 1, 0, items.splice(n, 1)[0]);
      if (b.dataset.act === "down" && n < items.length - 1) items.splice(n + 1, 0, items.splice(n, 1)[0]);
      if (b.dataset.act === "reset") Object.assign(it, { cx: 0.5, cy: 0.5, zoom: 1 });
      render();
      const again = igList.querySelector('[data-index="' + Math.min(Math.max(b.dataset.act === "up" ? n - 1 : b.dataset.act === "down" ? n + 1 : n, 0), items.length - 1) + '"] [data-act="' + b.dataset.act + '"]');
      if (again && !again.disabled) again.focus();
    });
    // Drag or arrow keys move the focus point of a cropped photo.
    function nudge(li, dx, dy, dz) {
      const it = items[Number(li.dataset.index)], im = load(it.url), p = planFor(li);
      if (!p || it.mode !== "crop") return;
      it.cx = Math.min(1, Math.max(0, (p.src.x + p.src.w / 2 + dx * p.src.w) / im.naturalWidth));
      it.cy = Math.min(1, Math.max(0, (p.src.y + p.src.h / 2 + dy * p.src.h) / im.naturalHeight));
      if (dz) { it.zoom = Math.min(MAXZ, Math.max(1, Math.round((it.zoom + dz) * 100) / 100)); li.querySelector('input[type="range"]').value = String(it.zoom); }
      draw(li); sync();
    }
    let drag = null;
    igList.addEventListener("pointerdown", e => {
      const cv = e.target.closest(".ig-out");
      if (!cv) return;
      const li = cv.closest(".ig-item");
      if (items[Number(li.dataset.index)].mode !== "crop") return;
      drag = { li, x: e.clientX, y: e.clientY, w: cv.clientWidth, h: cv.clientHeight };
      cv.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    igList.addEventListener("pointermove", e => {
      if (!drag) return;
      // Dragging the picture right shows more of its left side.
      nudge(drag.li, -(e.clientX - drag.x) / drag.w, -(e.clientY - drag.y) / drag.h, 0);
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const endDrag = () => { if (drag) { drag = null; recheck(); } };
    igList.addEventListener("pointerup", endDrag);
    igList.addEventListener("pointercancel", endDrag);
    igList.addEventListener("keydown", e => {
      const cv = e.target.closest(".ig-out");
      if (!cv) return;
      const li = cv.closest(".ig-item"), step = e.shiftKey ? 0.1 : 0.02;
      const map = { ArrowLeft: [-step, 0, 0], ArrowRight: [step, 0, 0], ArrowUp: [0, -step, 0], ArrowDown: [0, step, 0], "+": [0, 0, 0.1], "=": [0, 0, 0.1], "-": [0, 0, -0.1] };
      if (!map[e.key]) return;
      e.preventDefault();
      nudge(li, map[e.key][0], map[e.key][1], map[e.key][2]);
    });
    const videoSelector=document.getElementById("ig-video-source");
    videoSelector?.addEventListener("change",()=>{
      if(videoSelector.value && items.length){
        if(!confirm("Switch Instagram to a Reel? This clears its selected photos and crop settings.")){
          videoSelector.value="";
          return;
        }
        items.splice(0);
        render();
      }
      recheck();
    });
    const add = url => {
      if(videoSelector?.value){
        alert("Switch Instagram to the photo carousel first, then add photos.");
        return;
      }
      if (items.length < MAX && !items.some(x => x.url === url)) items.push({ url, mode: "crop", cx: 0.5, cy: 0.5, zoom: 1, bg: "dark" });
    };
    igList.parentElement.querySelectorAll(".ig-add").forEach(b => b.addEventListener("click", () => { add(b.dataset.url); render(); }));
    document.getElementById("ig-add-all")?.addEventListener("click", () => { pool.forEach(x => add(x.url)); render(); });
    form.querySelectorAll('input[name="ig_frame"]').forEach(r => r.addEventListener("change", () => igList.querySelectorAll(".ig-item").forEach(draw)));
    form.querySelectorAll("[data-ig-all]").forEach(b => b.addEventListener("click", () => { items.forEach(it => { it.mode = b.dataset.igAll; }); render(); }));
    const igPreview=document.getElementById("ig-reel-preview");
    const igSpecs=document.getElementById("ig-reel-specs");
    igPreview?.addEventListener("loadedmetadata",()=>{
      const ratio=igPreview.videoWidth && igPreview.videoHeight ?
        igPreview.videoWidth/igPreview.videoHeight : 0;
      const duration=igPreview.duration;
      const notes=[];
      if(ratio && Math.abs(ratio-9/16)>0.04)
        notes.push("This source is not 9:16; Instagram may crop or letterbox it.");
      if(Number.isFinite(duration) && (duration<3 || duration>900))
        notes.push("Duration is outside the recommended 3 seconds to 15 minutes.");
      igSpecs.textContent=(notes.length?notes.join(" "):"Frame and duration appear suitable. ")+
        "GS Poster does not transcode. Verify H.264 video and Advanced Audio Coding before posting.";
    });
    // After an autosave, the download links must name exactly the saved photos.
    document.addEventListener("gs-saved", () => {
      const hasVideo=!!videoSelector?.value;
      const reelDownload=document.getElementById("ig-reel-download");
      if(reelDownload)reelDownload.hidden=!hasVideo;
      if(igPreview){
        igPreview.hidden=!hasVideo;
        if(hasVideo){igPreview.load();}
      }
      savedValue = igField.value;
      const dl = document.getElementById("ig-downloads"), post = igList.dataset.post;
      if (!dl) return;
      dl.querySelectorAll("a").forEach(a => a.remove());
      items.forEach((_, n) => {
        if (n) dl.append(" · ");
        const a = el("a", { href: "/instagram/" + post + "/" + n + ".jpg", download: "instagram-" + post + "-" + (n + 1) + ".jpg" }, "Photo " + (n + 1));
        dl.append(a);
      });
      sync();
    });
    igApi = { get items() { return items; }, lowRes: () => igList.querySelectorAll('.ig-item[data-lowres="1"]').length };
    render();
  }
  form.addEventListener("input", recheck);
  form.addEventListener("change", recheck);
  recheck();
  const when = document.getElementById("ed-when");
  const touch = el => { el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
  document.getElementById("ed-now")?.addEventListener("click", () => { when.value = ""; touch(when); });
  document.getElementById("ed-earliest")?.addEventListener("click", async () => {
    const btn = document.getElementById("ed-earliest");
    const fb = form.querySelector('input[name="p_facebook"]')?.checked;
    const photos = Array.from(form.querySelectorAll('[data-media="facebook"] [data-tile="photo"]'))
      .filter(t => !t.querySelector(".tile-remove input")?.checked).length;
    btn.disabled = true;
    try {
      const r = await fetch("/earliest-time?facebook=" + (fb ? "1" : "0") + "&photos=" + photos, { credentials: "same-origin", headers: { Accept: "application/json" } });
      const body = await r.json();
      if (r.ok && body.local) { when.value = body.local; touch(when); }
    } catch {} finally { btn.disabled = false; }
  });

  // Autosave (#61): about a second after the last edit, the same signed-in,
  // CSRF and version-fenced save runs and returns JSON. One save at a time;
  // edits made while one is in flight are saved next. A refused save keeps
  // every edit on the page. Saving never approves or publishes.
  const STRUCTURAL = /^(p_|remove_|order_|tt_copy_fb$|bs_copy_fb_video$|ig_video_source$|tiktok_title$|tiktok_caption$|when$)/;
  const structural = snap => JSON.stringify(JSON.parse(snap).filter(([k]) => STRUCTURAL.test(k)));
  let timer = null, inflight = false, stopped = false, needsReload = false;
  function setVersion(v) {
    document.querySelectorAll('input[name="expected_updated_at"]').forEach(i => { i.value = v; });
    const panel = document.getElementById("draft-media-panel");
    if (panel) panel.dataset.version = v;
  }
  function maybeReload() {
    if (!needsReload || inflight || dirty()) return;
    // Platforms, removed media or the time changed: reload so the release
    // panel lists exactly what is saved. Not while the time field is in use.
    const focused = document.activeElement;
    if (focused === when || focused?.name === "tiktok_title" || focused?.name === "tiktok_caption") {
      focused.addEventListener("blur", maybeReload, { once: true }); return;
    }
    submitting = true;
    location.reload();
  }
  function schedule(delay) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(autosave, delay ?? 1000);
  }
  async function autosave() {
    if (stopped || !dirty()) { refresh(); return; }
    if (inflight || window.gsMediaBusy) { schedule(); return; }
    inflight = true;
    saveState = "Saving...";
    refresh();
    const sent = snapshot(), before = baseline;
    try {
      const r = await fetch(form.action, { method: "POST", body: new FormData(form), credentials: "same-origin",
        headers: { "X-GS-Autosave": "1", Accept: "application/json" } });
      let body = {};
      try { body = await r.json(); } catch {}
      if (r.ok && body.ok && body.updated_at) {
        setVersion(body.updated_at);
        baseline = sent;
        saveState = "";
        if (structural(before) !== structural(sent)) needsReload = true;
        document.dispatchEvent(new CustomEvent("gs-saved"));
      } else {
        // 409: changed elsewhere or no longer a draft. Stop, keep the edits.
        if (r.status === 409) stopped = true;
        saveState = "Save failed: " + (body.error || "the server answered " + r.status + ".") + (stopped ? " Your text is still on this page: copy what you need before reloading." : "");
      }
    } catch {
      saveState = "Save failed: no connection. Your changes are still here and will be saved when you edit again.";
    } finally {
      inflight = false;
      refresh();
      if (!stopped && dirty() && !saveState) schedule();
      maybeReload();
    }
  }
  form.addEventListener("input", () => { if (!saveState.startsWith("Save failed") || !stopped) { if (!inflight) saveState = ""; } schedule(); });
  form.addEventListener("change", () => schedule());
  // The Save button saves now instead of a full page post; without JavaScript
  // the form still posts normally.
  form.addEventListener("submit", e => { e.preventDefault(); clearTimeout(timer); autosave(); });
  // Enter inside the media uploader must not submit the editor form.
  document.getElementById("draft-media-panel")?.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault();
  });
  form.addEventListener("input", refresh);
  form.addEventListener("change", refresh);
  // Reorder one platform gallery at a time. Original data-index values
  // determine the saved order; dragging never changes another platform.
  function syncTileOrder(box) {
    const now = Array.from(box.querySelectorAll(":scope > [data-index]"));
    now.forEach((t, k) => {
      const pos = t.querySelector(".tile-pos");
      if (pos) pos.textContent = String(k + 1);
      t.querySelector('[data-move="-1"]').disabled = k === 0;
      t.querySelector('[data-move="1"]').disabled = k === now.length - 1;
    });
    const field = form.querySelector('input[name="' + box.dataset.order + '"]');
    if (field) {
      field.value = now.map(t => t.dataset.index).join(",");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  form.addEventListener("click", e => {
    const btn = e.target.closest("[data-move]");
    if (!btn) return;
    const tile = btn.closest("[data-tile]"), box = tile.parentElement;
    const tiles = Array.from(box.querySelectorAll(":scope > [data-index]"));
    const at = tiles.indexOf(tile), to = at + Number(btn.dataset.move);
    if (to < 0 || to >= tiles.length) return;
    if (to > at) tiles[to].after(tile); else tiles[to].before(tile);
    syncTileOrder(box);
    const again = tile.querySelector('[data-move="' + btn.dataset.move + '"]');
    (again && !again.disabled ? again : tile.querySelector("[data-move]:not([disabled])"))?.focus();
  });
  let dragTile = null;
  form.addEventListener("dragstart", e => {
    const tile = e.target.closest('.tiles[data-order] > [data-index][draggable="true"]');
    if (!tile || !e.dataTransfer) return;
    dragTile = tile;
    tile.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", tile.dataset.index);
  });
  form.addEventListener("dragover", e => {
    if (!dragTile) return;
    const target = e.target.closest('.tiles[data-order] > [data-index]');
    if (!target || target === dragTile || target.parentElement !== dragTile.parentElement) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    form.querySelectorAll(".tiles > .drop-target").forEach(x => x.classList.remove("drop-target"));
    target.classList.add("drop-target");
  });
  form.addEventListener("drop", e => {
    if (!dragTile) return;
    const target = e.target.closest('.tiles[data-order] > [data-index]');
    if (!target || target === dragTile || target.parentElement !== dragTile.parentElement) return;
    e.preventDefault();
    const box = dragTile.parentElement;
    const tiles = Array.from(box.querySelectorAll(":scope > [data-index]"));
    if (tiles.indexOf(dragTile) < tiles.indexOf(target)) target.after(dragTile);
    else target.before(dragTile);
    syncTileOrder(box);
    form.querySelectorAll(".tiles > .drop-target").forEach(x => x.classList.remove("drop-target"));
    dragTile.classList.remove("dragging");
    dragTile = null;
  });
  form.addEventListener("dragend", () => {
    if (dragTile) dragTile.classList.remove("dragging");
    dragTile = null;
    form.querySelectorAll(".tiles > .drop-target").forEach(x => x.classList.remove("drop-target"));
  });
  form.querySelectorAll("[data-order]").forEach(box => {
    const tiles = box.querySelectorAll(":scope > [data-index]");
    tiles.forEach((t, k) => {
      t.querySelector('[data-move="-1"]').disabled = k === 0;
      t.querySelector('[data-move="1"]').disabled = k === tiles.length - 1;
    });
  });

  // TikTok in the release form: unticking it hides its details and drops
  // the consent requirement; the server checks the same on approval.
  const ttToggle = document.querySelector("[data-tt-toggle]");
  if (ttToggle) {
    const sync = () => {
      document.querySelector("[data-tt-details]").hidden = !ttToggle.checked;
      document.querySelector("[data-tt-required]").required = ttToggle.checked;
    };
    ttToggle.addEventListener("change", sync);
    sync();
  }
  window.addEventListener("beforeunload", e => {
    if (!submitting && (dirty() || inflight)) { e.preventDefault(); e.returnValue = ""; }
  });
  refresh();
})();
`;
