/** Standalone new-draft form. Draft creation never approves or publishes. */
import { esc } from "./html.ts";
import { checkWhen, APPROVE_MIN_LEAD_MS } from "./validate.ts";
import { localToUtc, toLocalInput } from "./time.ts";
import { textLength } from "./bluesky.ts";
import type { NewPost } from "./db.ts";

export interface NewDraftFields {
  label: string; release: string; message: string; bsCaption: string;
  facebook: boolean; bluesky: boolean; tiktok?: boolean; when: string;
  contentKind?: "text" | "images" | "video";
}
export function blankNewDraft(when = ""): NewDraftFields {
  return {label:"",release:"",message:"",bsCaption:"",facebook:true,bluesky:true,tiktok:false,when,contentKind:"text"};
}

/** Explicit presets only, selected through GET links. No preset approves or publishes. */
export function presetNewDraft(preset: string | null, when = ""): NewDraftFields {
  const base=blankNewDraft(when);
  if(preset==="tiktok-carousel") return {...base,facebook:false,bluesky:false,tiktok:true,contentKind:"images"};
  if(preset==="tiktok-video") return {...base,facebook:false,bluesky:false,tiktok:true,contentKind:"video"};
  return base;
}
/** Reject forged, stale or non-existent local times, including DST gaps. */
export function newDraftTime(value: string, zone: string, now = new Date()): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error("Choose a valid date and time.");
  const date = localToUtc(value,zone);
  if (!Number.isFinite(date.getTime()) || toLocalInput(date,zone)!==value)
    throw new Error("This wall-clock time does not exist in the selected time zone.");
  const error=checkWhen(date,now,APPROVE_MIN_LEAD_MS);
  if(error)throw new Error(error);
  return date;
}
/** Earliest whole-minute slot that remains at least 12 minutes in the future. */
export function soonestDraftTime(zone:string,now=new Date()):string {
  const rounded=Math.ceil((now.getTime()+APPROVE_MIN_LEAD_MS)/60_000)*60_000;
  return toLocalInput(new Date(rounded),zone);
}
export function newDraftPrefill(value: string | null, zone: string, now = new Date()): string {
  if(!value)return "";
  try{newDraftTime(value,zone,now);return value;}catch{return "";}
}
export function parseNewDraft(
  fields: NewDraftFields, zone: string, actor: string, now = new Date(),
): NewPost {
  if (!fields.facebook && !fields.bluesky && !fields.tiktok) throw new Error("Select Facebook, Bluesky, or TikTok.");
  if(fields.tiktok && !["images","video"].includes(fields.contentKind||"")) throw new Error("TikTok supports videos and photo carousels. Select Images or Video.");
  if (fields.contentKind && !["text","images","video"].includes(fields.contentKind)) throw new Error("Choose a supported content type.");
  if(fields.label.length>120 || fields.release.length>120)
    throw new Error("Name and release must each be 120 characters or fewer.");
  if(fields.message.length>63_206)
    throw new Error("Facebook caption exceeds its maximum length.");
  if(textLength(fields.bsCaption)>300 || new TextEncoder().encode(fields.bsCaption).length>3000)
    throw new Error("Bluesky caption exceeds its 300-character limit.");
  const scheduledAt=newDraftTime(fields.when,zone,now);
  return {
    message: fields.message, label: fields.label.trim() || null,
    release:fields.release.trim() || null,
    images:[],video:null,link:null,
    scheduled_at:scheduledAt?.toISOString() || null,
    facebook_enabled:fields.facebook,
    tiktok_enabled:fields.tiktok===true,
    bluesky:fields.bluesky ? {caption:fields.bsCaption,images:[],video:null,patreon:null} : null,
    created_by:"GS Poster web (via "+actor+")",
  };
}

export function renderNewDraft(fields:NewDraftFields,csrf:string,zone:string,error?:string):string {
  const v=(s:string)=>esc(s);
  const kind=fields.contentKind ?? "text";
  return `
  <div class="hero">
    <div class="hero-kicker">GS Grimoire · New post draft</div>
    <h2>Make something worth sharing.</h2>
    <p>Build once, tailor by platform, preview every image and save an unapproved draft. Nothing goes live until you choose a separate publishing action.</p>
  </div>
  ${error?`<div class="notice err" role="alert">${v(error)}</div>`:""}
  <style>
  #new-draft-form [hidden]{display:none!important}
  #new-draft-form .step-card{scroll-margin-top:20px}
  .new-choice-group{margin:0}
  .new-drop{border:2px dashed var(--line);border-radius:12px;padding:21px;text-align:center;cursor:pointer;margin:10px 0;background:color-mix(in srgb,var(--panel) 70%,var(--bg))}
  .new-drop:hover,.new-drop:focus,.new-drop.drag-over{border-color:var(--accent2);background:color-mix(in srgb,var(--accent2) 9%,var(--panel))}
  .new-drop strong,.new-drop span{display:block}
  .new-drop strong{font:700 15px system-ui,sans-serif}
  .new-drop span{font:13px system-ui,sans-serif;color:var(--muted);margin-top:4px}
  .new-file{display:grid;grid-template-columns:78px minmax(0,1fr);gap:10px 14px;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:10px;margin:9px 0}
  .new-file img{width:78px;height:88px;object-fit:cover;border-radius:7px;grid-row:span 2}
  .new-file label{margin:0;grid-column:2}
  .new-file input{width:100%}
  .new-file .gallery-controls{grid-column:2}
  .new-file .file-title{font:600 13px/1.4 system-ui,sans-serif;min-width:0;overflow-wrap:anywhere}
  #new-video-preview{width:100%;max-height:340px;border-radius:10px;margin-top:8px}
  #new-draft-form .step-card label{margin-top:9px}
  #new-draft-form .choice-tile{margin:0!important}
  #new-draft-form .step-card textarea{min-height:120px}
  #new-draft-status:not(:empty){margin:12px 0 0;padding:12px;border-radius:9px;background:var(--surface2)}
  #new-asap-button[aria-pressed=true]{background:var(--surface2);border-color:var(--accent2)}
  </style>
  <form class="workspace-grid" method="post" action="/new" id="new-draft-form" data-zone="${v(zone)}">
    <input type="hidden" name="csrf" value="${v(csrf)}">
    <div class="workspace-main">
      <section class="step-card" aria-labelledby="draft-platform-title">
        <div class="step-heading"><span class="step-number">1</span><div><h3 id="draft-platform-title">Where will this go?</h3><p class="hint">Each platform can be selected independently.</p></div></div>
        <div class="choice-tiles new-choice-group">
          <label class="choice-tile"><input type="checkbox" name="facebook" value="1" ${fields.facebook?"checked":""}> Facebook</label>
          <label class="choice-tile"><input type="checkbox" name="bluesky" value="1" ${fields.bluesky?"checked":""}> Bluesky</label>
          <label class="choice-tile"><input type="checkbox" name="tiktok" value="1" ${fields.tiktok?"checked":""}> TikTok</label>
        </div>
        <p class="choice-advice" id="new-platform-advice">TikTok videos and carousels can go to the inbox for manual publication. Private direct posting requires separate permission and approval. Calendar times do not automatically publish to TikTok.</p>
      </section>

      <section class="step-card" aria-labelledby="draft-content-title">
        <div class="step-heading"><span class="step-number">2</span><div><h3 id="draft-content-title">What are you sharing?</h3><p class="hint">Choose a format, then add media below.</p></div></div>
        <div class="choice-tiles new-choice-group" role="group" aria-label="Post content type">
          <label class="choice-tile"><input type="radio" name="content_kind" value="text" ${kind==="text"?"checked":""}> Text</label>
          <label class="choice-tile"><input type="radio" name="content_kind" value="images" ${kind==="images"?"checked":""}> Image carousel</label>
          <label class="choice-tile"><input type="radio" name="content_kind" value="video" ${kind==="video"?"checked":""}> Video</label>
        </div>
        <section id="new-images-panel" ${kind!=="images"?"hidden":""}>
          <p class="form-info" id="new-image-guidance">Images stay in their selected order. Rearrange them before saving. Up to 35 for TikTok, four for Bluesky and 80 for Facebook.</p>
          <div id="new-images-drop" class="new-drop" tabindex="0" role="button" aria-label="Choose or drop images">
            <strong>Drop your artwork here</strong>
            <span>Or select JPG, PNG or GIF files, up to 10 MB each</span>
          </div>
          <input type="file" id="new-images-input" accept=".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif" multiple aria-label="Select image files">
          <p class="media-count" id="new-image-count" aria-live="polite">No images selected</p>
          <div id="new-images-preview" aria-live="polite"></div>
        </section>
        <section id="new-video-panel" ${kind!=="video"?"hidden":""}>
          <p class="form-info">One MP4 video, up to 20 MB. Original video uploads remain private until you explicitly approve a transfer.</p>
          <div id="new-video-drop" class="new-drop" tabindex="0" role="button" aria-label="Choose or drop MP4 video">
            <strong>Drop your video here</strong>
            <span>Or select an MP4 file to preview, up to 20 MB</span>
          </div>
          <input type="file" id="new-video-input" accept=".mp4,video/mp4" aria-label="Select video file">
          <video id="new-video-preview" controls playsinline preload="metadata" hidden></video>
          <p id="new-video-name" class="media-count"></p>
          <label id="new-video-alt-label" for="new-video-alt">Video accessibility description for Bluesky
            <input type="text" id="new-video-alt" maxlength="1000" placeholder="Describe what the video shows">
          </label>
        </section>
      </section>

      <section class="step-card" aria-labelledby="draft-copy-title">
        <div class="step-heading"><span class="step-number">3</span><div><h3 id="draft-copy-title">Tell the story</h3><p class="hint">Tailor the caption to each destination.</p></div></div>
        <section id="new-facebook-panel">
          <label for="new-message">Facebook / TikTok caption</label>
          <textarea id="new-message" name="message" maxlength="63206" placeholder="Your story, hook or announcement...">${v(fields.message)}</textarea>
          <div class="field-meter" id="new-main-count">0 characters</div>
          <p class="form-info" id="new-tiktok-caption-advice" hidden>TikTok photo descriptions can contain up to 4,000 characters. Review the final caption again in TikTok posting options.</p>
        </section>
        <section id="new-bluesky-panel">
          <label for="new-bs">Bluesky caption (up to 300 characters)</label>
          <textarea id="new-bs" name="bs_caption" maxlength="300" style="min-height:110px" placeholder="A shorter companion caption...">${v(fields.bsCaption)}</textarea>
          <div class="field-meter" id="new-bs-count">0 / 300</div>
        </section>
      </section>

      <section class="step-card" aria-labelledby="draft-details-title">
        <div class="step-heading"><span class="step-number">4</span><div><h3 id="draft-details-title">Name it and plan it</h3><p class="hint">The name helps you find this post later.</p></div></div>
        <label for="new-label">Post name (optional)</label>
        <input id="new-label" name="label" type="text" maxlength="120" value="${v(fields.label)}" placeholder="House Rule Compendium carousel">
        <label for="new-release">Release or collection (optional)</label>
        <input id="new-release" name="release" type="text" maxlength="120" value="${v(fields.release)}" placeholder="Halloween / Chapter 2 / Weekly magic items">
        <label for="new-when">Proposed calendar time (${v(zone)})</label>
        <input type="hidden" name="asap" id="new-asap" value="0">
        <div class="inline-actions">
          <input id="new-when" type="datetime-local" name="when" value="${v(fields.when)}" style="flex:1;min-width:190px">
          <button id="new-asap-button" type="button" aria-pressed="false">As soon as possible (+12 min)</button>
          <button id="new-clear-time" type="button">Clear time</button>
        </div>
        <p class="form-info" id="new-timing-advice">Saving is never approval. Facebook and Bluesky scheduling requires separate approval with your PIN; TikTok transfers remain manual for now.</p>
      </section>
    </div>
    <aside class="workspace-rail" aria-label="Draft overview">
      <div class="step-card">
        <div class="eyebrow">Your draft at a glance</div>
        <h3 style="margin:9px 0 15px">Ready when you are</h3>
        <div class="summary-row"><span>Destinations</span><strong id="summary-platforms">Choose platforms</strong></div>
        <div class="summary-row"><span>Format</span><strong id="summary-format">Text</strong></div>
        <div class="summary-row"><span>Media</span><strong id="summary-media">No media selected</strong></div>
        <div class="summary-row"><span>Calendar</span><strong id="summary-timing">Not scheduled</strong></div>
        <div class="summary-row"><span>Next step</span><strong id="summary-readiness">Save as draft</strong></div>
        <div class="progress-track" role="progressbar" aria-label="Media transfer progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="new-upload-progress"><span class="progress-fill" id="new-progress-fill"></span></div>
        <p class="rail-note" id="new-progress-caption">Media will upload only after you save.</p>
        <button class="primary" type="submit" id="new-draft-submit" style="width:100%;margin-top:17px">Save draft and media</button>
        <p id="new-draft-status" role="status" aria-live="polite" class="form-info"></p>
        <a href="/" class="btn" style="display:block;text-align:center;margin-top:10px">Back to planner</a>
        <p class="rail-note"><span class="status-led"></span> Unapproved by default. Your content cannot publish from this screen.</p>
        <p class="rail-note">If scripts are disabled, Save creates a text draft; attach media on the review page.</p>
      </div>
    </aside>
  </form>
  <script src="/new-draft.js" defer></script>
  `
}
