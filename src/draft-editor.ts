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

const FB_MAX = 63_206;
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
  const ttLimit = ttIsVideo ? 2200 : 4000;
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
  return `<figure class="tile"><img loading="lazy" src="${esc(src)}" alt="${esc(alt)}">
    <label class="tile-remove"><input type="checkbox" name="${esc(removeName)}" value="1"> Remove</label>${extra}</figure>`;
}

function video(src: string, removeName: string, extra = ""): string {
  return `<figure class="tile tile-video"><video controls playsinline preload="metadata" src="${esc(src)}"></video>
    <label class="tile-remove"><input type="checkbox" name="${esc(removeName)}" value="1"> Remove video</label>${extra}</figure>`;
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
  const fbMedia = p.video
    ? video(`/video/${p.id}/facebook`, "remove_fb_video")
    : p.images.map((_, i) => tile(`/media/${p.id}/${i}`, `Facebook photo ${i + 1}`, "remove_fb_" + i)).join("");
  const bsMedia = bs?.video
    ? video(`/video/${p.id}/bluesky`, "remove_bs_video",
      `<label>Describe the video<input type="text" name="bs_video_alt" maxlength="${MAX_ALT}" value="${esc(bs.video.alt)}"></label>`)
    : (bs?.images ?? []).map((img, i) => tile(`/media/${p.id}/${i}?platform=bluesky`, `Bluesky photo ${i + 1}`, "remove_bs_" + i,
      `<label>Describe the image<input type="text" name="bs_alt_${i}" maxlength="${MAX_ALT}" value="${esc(img.alt)}" placeholder="Required by Bluesky"></label>`)).join("");
  const ttMedia = ttShared
    ? `<p class="hint">TikTok uses the Facebook ${p.video ? "video" : "photos"}.</p>`
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
.editor-shell{max-width:1180px;margin:0 auto}
.editor-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);gap:20px;align-items:start}
.editor-rail{position:sticky;top:16px;display:grid;gap:14px}
.editor-head{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin:0 0 14px;font:14px system-ui,sans-serif;color:var(--muted)}
.editor-head strong{font:650 20px/1.25 system-ui,sans-serif;color:var(--text)}
.ed-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:14px}
.ed-card>h3{margin:0 0 12px}
.platform-chips{display:flex;flex-wrap:wrap;gap:8px}
.platform-chip{margin:0!important;padding:10px 14px;border:1px solid var(--line);border-radius:99px;background:var(--bg);cursor:pointer;font:600 14px system-ui,sans-serif!important;align-items:center!important}
.platform-chip:has(input:checked){border-color:var(--accent2);background:color-mix(in srgb,var(--accent2) 15%,var(--panel))}
.media-block{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}
.media-block:first-of-type{border-top:0;margin-top:0;padding-top:0}
.media-block h4{font:650 14px system-ui,sans-serif;margin:0 0 8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px}
.tile{margin:0;border:1px solid var(--line);border-radius:10px;padding:6px;background:var(--bg);display:grid;gap:6px}
.tile img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:6px;display:block}
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
.caption-grid{display:grid;gap:14px}
.caption-box h4{font:650 14px system-ui,sans-serif;margin:0}
.caption-box textarea{min-height:150px}
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

    <section class="ed-card" aria-labelledby="ed-media">
      <h3 id="ed-media">Photos and video</h3>
      <div class="media-block" data-platform="facebook"${hide(p.facebook_enabled)}><h4>Facebook</h4><div class="tiles">${fbMedia || empty}</div></div>
      <div class="media-block" data-platform="bluesky"${hide(!!bs)}><h4>Bluesky <span class="hint">(up to 4 photos, each needs a description)</span></h4><div class="tiles">${bsMedia || empty}</div></div>
      <div class="media-block" data-platform="tiktok"${hide(!!p.tiktok_enabled)}><h4>TikTok</h4><div class="tiles">${ttMedia || empty}</div></div>
      ${v.mediaPanel}
    </section>

    <section class="ed-card" aria-labelledby="ed-captions">
      <h3 id="ed-captions">Captions</h3>
      <div class="caption-grid">
        <div class="caption-box" data-platform="facebook"${hide(p.facebook_enabled)}>
          <label for="ed-message"><h4>Facebook</h4></label>
          <textarea id="ed-message" name="message" maxlength="${FB_MAX}" data-max="${FB_MAX}">${esc(p.message)}</textarea>
          <div class="field-meter"></div>
        </div>
        <div class="caption-box" data-platform="bluesky"${hide(!!bs)}>
          <label for="ed-bs"><h4>Bluesky</h4></label>
          <textarea id="ed-bs" name="bs_caption" data-max="${BSKY_TEXT_LIMIT}" placeholder="A short companion caption">${esc(bs?.caption ?? "")}</textarea>
          <div class="field-meter"></div>
          <details${bs?.patreon ? " open" : ""}><summary>Patreon link card (optional)</summary>
            <label for="ed-patreon-url">Free Patreon post URL</label>
            <input id="ed-patreon-url" type="text" name="bs_patreon_url" value="${esc(bs?.patreon?.url ?? "")}" placeholder="https://www.patreon.com/posts/...">
            <label for="ed-patreon-title">Card title</label>
            <input id="ed-patreon-title" type="text" name="bs_patreon_title" value="${esc(bs?.patreon?.title ?? "")}">
            <label for="ed-patreon-desc">Card description</label>
            <input id="ed-patreon-desc" type="text" name="bs_patreon_description" value="${esc(bs?.patreon?.description ?? "")}">
          </details>
        </div>
        <div class="caption-box" data-platform="tiktok"${hide(!!p.tiktok_enabled)}>
          <label for="ed-tiktok"><h4>TikTok</h4></label>
          <textarea id="ed-tiktok" name="tiktok_caption" data-max="${(ttShared ? p.video : tt.video) ? 2200 : 4000}" placeholder="Leave empty to reuse the Facebook caption">${esc(p.tiktok_caption ?? "")}</textarea>
          <div class="field-meter"></div>
        </div>
      </div>
      ${v.checksHtml ? `<ul class="checks">${v.checksHtml}</ul>` : ""}
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
    const n = Array.from(area.value).length;
    out.textContent = n + " / " + max;
    out.style.color = n > max ? "var(--err)" : "";
  }
  form.querySelectorAll("textarea[data-max]").forEach(a => { meter(a); a.addEventListener("input", () => meter(a)); });
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
