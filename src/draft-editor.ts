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

const FB_MAX = FACEBOOK_CAPTION_MAX;
const MAX_ALT = 1000;

export interface EditorParse {
  errors: string[];
  next?: EditorDraft;
  bluesky?: BlueskyDraft | null;
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

/** Read the editor form against the current post. Only hard limits block a save. */
export function parseEditorForm(form: FormData, cur: Post, tz: string): EditorParse {
  const errors: string[] = [];
  const facebook = form.get("p_facebook") === "1";
  const blueskyOn = form.get("p_bluesky") === "1";
  const tiktok = form.get("p_tiktok") === "1";
  if (!facebook && !blueskyOn && !tiktok) errors.push("Choose at least one platform.");

  const message = text(form, "message", cur.message);
  if (message.length > FB_MAX) errors.push(`The Facebook caption is ${message.length} characters; Facebook allows ${FB_MAX}.`);

  const images = kept(cur.images, form, "remove_fb_");
  const video = cur.video && form.get("remove_fb_video") !== "1" ? cur.video : null;
  const tiktokImages = cur.tiktok_images === null ? null : kept(cur.tiktok_images, form, "remove_tt_");
  const tiktokVideo = cur.tiktok_video && form.get("remove_tt_video") !== "1" ? cur.tiktok_video : null;
  const ttCaptionRaw = text(form, "tiktok_caption", cur.tiktok_caption ?? "").trim();
  const tiktokCaption = ttCaptionRaw || null;
  const ttIsVideo = tiktokImages === null ? !!video : !!tiktokVideo;
  const ttLimit = captionLimit("tiktok", { photos: 1, video: ttIsVideo });
  if (tiktok && (tiktokCaption ?? message).length > ttLimit)
    errors.push(`The TikTok caption is too long; TikTok allows ${ttLimit} characters for this format.`);

  let bluesky: BlueskyDraft | null = null;
  if (blueskyOn) {
    const base = cur.bluesky ?? { caption: "", images: [], video: null, patreon: null };
    const caption = text(form, "bs_caption", base.caption);
    if (textLength(caption) > BSKY_TEXT_LIMIT) errors.push(`The Bluesky caption is over ${BSKY_TEXT_LIMIT} characters.`);
    const bsImages = base.images
      .map((img, i) => ({ url: img.url, alt: text(form, "bs_alt_" + i, img.alt).trim() }))
      .filter((_, i) => form.get("remove_bs_" + i) !== "1");
    const bsVideo = base.video && form.get("remove_bs_video") !== "1"
      ? { url: base.video.url, alt: text(form, "bs_video_alt", base.video.alt).trim() } : null;
    for (const a of [...bsImages.map((x) => x.alt), ...(bsVideo ? [bsVideo.alt] : [])])
      if (a.length > MAX_ALT) errors.push(`Alternative text is limited to ${MAX_ALT} characters.`);
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
    next: {
      message, tiktok_caption: tiktokCaption, images, tiktok_images: tiktokImages, video,
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
  mediaLooksPending: boolean;
  createdLine: string;
}

function tile(src: string, alt: string, removeName: string, extra = ""): string {
  return `<figure class="tile" data-tile="photo"><div class="tile-frame"><img loading="lazy" src="${esc(src)}" alt="${esc(alt)}">
    <span class="tile-ratio" data-ratio-badge hidden></span></div>
    <label class="tile-remove"><input type="checkbox" name="${esc(removeName)}" value="1"> Remove</label>${extra}</figure>`;
}

function video(src: string, removeName: string, extra = ""): string {
  return `<figure class="tile tile-video" data-tile="video"><video controls playsinline preload="metadata" src="${esc(src)}"></video>
    <label class="tile-remove"><input type="checkbox" name="${esc(removeName)}" value="1"> Remove video</label>${extra}</figure>`;
}

/** Saved state of each platform's target, for the first render of the checks. */
export function targetStates(p: Post): Record<PlatformId, TargetState> {
  const bs = p.bluesky;
  const tt = tiktokMedia(p);
  const ttShared = p.tiktok_images === null;
  return {
    facebook: { id: "facebook", captionLength: p.message.length, photos: p.video ? 0 : p.images.length, video: !!p.video, missingAlt: 0 },
    bluesky: { id: "bluesky", captionLength: bs ? textLength(bs.caption) : 0,
      photos: bs?.video ? 0 : (bs?.images.length ?? 0), video: !!bs?.video,
      missingAlt: (bs?.images.filter((i) => !i.alt.trim()).length ?? 0) + (bs?.video && !bs.video.alt.trim() ? 1 : 0) },
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
    `shows best at ${r.aspect.label}`,
  ].filter(Boolean).join(" · ");
}

function checkItems(t: TargetState): string {
  const c = checkTarget(t);
  if (!c.errors.length && !c.warnings.length) return `<li class="ok">Ready for ${esc(PLATFORMS[t.id].label)}.</li>`;
  return [...c.errors.map((e) => `<li class="e">${esc(e)}</li>`), ...c.warnings.map((w) => `<li class="w">${esc(w)}</li>`)].join("");
}

const photos = (n: number) => n + (n === 1 ? " photo" : " photos");
const chip = (name: string, label: string, on: boolean) =>
  `<label class="platform-chip"><input type="checkbox" name="${name}" value="1" data-platform-toggle="${name.slice(2)}"${on ? " checked" : ""}> ${label}</label>`;

export function renderDraftEditor(v: EditorView): string {
  const p = v.post;
  const id = esc(p.id);
  const bs = p.bluesky;
  const tt = tiktokMedia(p);
  const ttShared = p.tiktok_images === null;
  const hide = (on: boolean) => (on ? "" : " hidden");
  const on: Record<PlatformId, boolean> = { facebook: p.facebook_enabled, bluesky: !!bs, tiktok: !!p.tiktok_enabled };
  const states = targetStates(p);
  const fbMedia = p.video
    ? video(`/video/${p.id}/facebook`, "remove_fb_video")
    : p.images.map((_, i) => tile(`/media/${p.id}/${i}`, `Facebook photo ${i + 1}`, "remove_fb_" + i)).join("");
  const bsMedia = bs?.video
    ? video(`/video/${p.id}/bluesky`, "remove_bs_video",
      `<label>Describe the video<input type="text" name="bs_video_alt" maxlength="${MAX_ALT}" value="${esc(bs.video.alt)}"></label>`)
    : (bs?.images ?? []).map((img, i) => tile(`/media/${p.id}/${i}?platform=bluesky`, `Bluesky photo ${i + 1}`, "remove_bs_" + i,
      `<label>Describe the image<input type="text" name="bs_alt_${i}" maxlength="${MAX_ALT}" value="${esc(img.alt)}" placeholder="Required by Bluesky"></label>`)).join("");
  const ttMedia = ttShared
    ? `<p class="hint shared-note">TikTok uses the Facebook ${p.video ? "video" : "photos"}, in the same order. Removing one from Facebook removes it here too.</p>`
    : tt.video
      ? video(`/video/${p.id}/tiktok`, "remove_tt_video")
      : tt.images.map((_, i) => tile(`/media/${p.id}/${i}?platform=tiktok`, `TikTok photo ${i + 1}`, "remove_tt_" + i)).join("");
  const empty = '<p class="hint">Nothing yet.</p>';
  const when = p.scheduled_at ? toLocalInput(new Date(p.scheduled_at), v.tz) : "";
  const releaseTargets = [
    p.facebook_enabled ? `<label><input type="checkbox" name="target_facebook" value="1" checked> Facebook · ${p.video ? "video" : photos(p.images.length)}</label>` : "",
    bs ? `<label><input type="checkbox" name="target_bluesky" value="1" checked> Bluesky · ${bs.video ? "video" : photos(bs.images.length)}</label>` : "",
  ].join("");
  const canRelease = !!(p.facebook_enabled || bs);
  const release = canRelease ? `
    <form method="post" action="/post/${id}/approve" class="release-card" id="release-form">
      <input type="hidden" name="csrf" value="${esc(v.csrf)}">
      <input type="hidden" name="expected_updated_at" value="${esc(p.updated_at)}">
      <div class="eyebrow">Release</div>
      <h3>${p.scheduled_at ? "Schedule for " + esc(v.whenText) : "Post as soon as you approve"}</h3>
      ${releaseTargets}
      ${v.releaseProblems.length ? `<ul class="checks">${v.releaseProblems.map((x) => `<li class="e">${esc(x)}</li>`).join("")}</ul>` : ""}
      ${p.facebook_enabled && p.images.length > 12 ? `<label><input type="checkbox" name="reviewed_all_images" value="1" required> I reviewed all ${p.images.length} Facebook photos.</label>` : ""}
      ${v.mediaLooksPending ? `<label><input type="checkbox" name="publish_without_media" value="1"> The name says media is pending, but Facebook has none. Publish without media anyway.</label>` : ""}
      <label for="release-pin">PIN</label>
      <input id="release-pin" type="password" name="pin" inputmode="numeric" autocomplete="off" required>
      <p class="hint release-dirty" id="release-dirty" hidden>Save your changes first. Release uses the saved version.</p>
      <div class="row"><button class="primary" id="release-button">${p.scheduled_at ? "Approve and schedule" : "Approve and post now"}</button></div>
      <p class="rail-note">Releases exactly the saved draft. TikTok is sent separately below.</p>
    </form>` : `<div class="release-card"><div class="eyebrow">Release</div><h3>TikTok only</h3>
      <p class="hint">Facebook and Bluesky are off. Send it to your TikTok inbox below.</p></div>`;

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
.house-title{font:650 14px system-ui,sans-serif;margin:16px 0 0}
.save-bar{position:sticky;bottom:0;z-index:2;display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px;margin-top:6px;background:color-mix(in srgb,var(--panel) 92%,transparent);backdrop-filter:blur(6px);border:1px solid var(--line);border-radius:14px}
.save-bar button{flex:0 0 auto}
.save-state{font:13px system-ui,sans-serif;color:var(--muted)}
.save-state.dirty{color:var(--warn);font-weight:600}
.release-card{background:var(--panel);border:1px solid var(--accent2);border-radius:14px;padding:18px}
.release-card h3{margin:6px 0 10px}
.time-row{display:flex;flex-wrap:wrap;gap:8px}
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
  <div class="editor-grid">
  <form method="post" action="/post/${id}/save" id="draft-editor">
    <input type="hidden" name="csrf" value="${esc(v.csrf)}">
    <input type="hidden" name="expected_updated_at" value="${esc(p.updated_at)}">

    <section class="ed-card" aria-labelledby="ed-platforms">
      <h3 id="ed-platforms">Platforms</h3>
      <div class="platform-chips">
        ${chip("p_facebook", "Facebook", p.facebook_enabled)}
        ${chip("p_bluesky", "Bluesky", !!bs)}
        ${chip("p_tiktok", "TikTok", !!p.tiktok_enabled)}
      </div>
      <p class="hint">Only the platforms you choose get a caption and media below. Turning Bluesky off removes its caption when you save.</p>
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
          <div class="tiles" data-media="facebook">${fbMedia || empty}</div>
        </article>
        <article class="target" id="target-bluesky" data-platform="bluesky"${hide(on.bluesky)} aria-labelledby="tg-bluesky">
          <div class="target-head"><h4 id="tg-bluesky">Bluesky</h4><p class="format">${esc(formatLine("bluesky"))}</p></div>
          <ul class="checks target-checks" data-checks="bluesky">${checkItems(states.bluesky)}</ul>
          <div class="cap-row"><label for="ed-bs" class="cap-label">Caption</label>
            <button type="button" class="copy-cap" data-copy-to="ed-bs" data-copy-from="ed-message">Copy Facebook caption</button></div>
          <textarea id="ed-bs" name="bs_caption" data-max="${BSKY_TEXT_LIMIT}" data-graphemes="1" data-caption="bluesky" placeholder="A short companion caption">${esc(bs?.caption ?? "")}</textarea>
          <div class="field-meter"></div>
          <div class="tiles" data-media="bluesky">${bsMedia || empty}</div>
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
          <div class="cap-row"><label for="ed-tiktok" class="cap-label">Caption</label>
            <button type="button" class="copy-cap" data-copy-to="ed-tiktok" data-copy-from="ed-message">Copy Facebook caption</button></div>
          <textarea id="ed-tiktok" name="tiktok_caption" data-max="${captionLimit("tiktok", { photos: 1, video: !!(ttShared ? p.video : tt.video) })}" data-caption="tiktok" placeholder="Leave empty to reuse the Facebook caption">${esc(p.tiktok_caption ?? "")}</textarea>
          <div class="field-meter"></div>
          <div class="tiles" data-media="tiktok">${ttMedia || empty}</div>
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
        <button type="button" id="ed-asap">In 15 minutes</button>
        <button type="button" id="ed-clear">No time</button>
      </div>
      <p class="hint">Empty means it posts when you approve. Scheduled posts need to be at least 12 minutes ahead (30 for photo posts) when you release.</p>
    </section>

    <div class="save-bar">
      <button class="primary" type="submit" id="ed-save">Save changes</button>
      <span class="save-state" id="ed-state" role="status" aria-live="polite">All changes saved</span>
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
export const DRAFT_EDITOR_JS = String.raw`
(() => {
  const form = document.getElementById("draft-editor");
  if (!form) return;
  const state = document.getElementById("ed-state");
  const releaseBtn = document.getElementById("release-button");
  const releaseNote = document.getElementById("release-dirty");
  const snapshot = () => JSON.stringify(Array.from(new FormData(form).entries()));
  const initial = snapshot();
  let submitting = false;
  const dirty = () => snapshot() !== initial;
  window.gsEditorDirty = dirty;
  function refresh() {
    const d = dirty();
    state.textContent = d ? "Unsaved changes" : "All changes saved";
    state.classList.toggle("dirty", d);
    if (releaseBtn) releaseBtn.disabled = d;
    if (releaseNote) releaseNote.hidden = !d;
  }
  function togglePlatform(box) {
    const name = box.dataset.platformToggle;
    form.querySelectorAll('[data-platform="' + name + '"]').forEach(el => { el.hidden = !box.checked; });
  }
  form.querySelectorAll("[data-platform-toggle]").forEach(box => box.addEventListener("change", () => togglePlatform(box)));
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
    if (!st.captionLength && r.id !== "tiktok") warnings.push("Caption is empty.");
    const off = st.ratios.filter(x => x < r.aspect.min - 0.01 || x > r.aspect.max + 0.01).length;
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
  form.addEventListener("input", recheck);
  form.addEventListener("change", recheck);
  recheck();
  const when = document.getElementById("ed-when");
  const pad = n => String(n).padStart(2, "0");
  document.getElementById("ed-asap")?.addEventListener("click", () => {
    const d = new Date(Date.now() + 15 * 60000);
    when.value = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
    refresh();
  });
  document.getElementById("ed-clear")?.addEventListener("click", () => { when.value = ""; refresh(); });
  // Enter inside the media uploader must not submit the editor form.
  document.getElementById("draft-media-panel")?.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault();
  });
  form.addEventListener("input", refresh);
  form.addEventListener("change", refresh);
  form.addEventListener("submit", () => { submitting = true; });
  window.addEventListener("beforeunload", e => {
    if (!submitting && dirty()) { e.preventDefault(); e.returnValue = ""; }
  });
  refresh();
})();
`;
