/** Standalone new-draft form. Draft creation never approves or publishes. */
import { esc, helpTip } from "./html.ts";
import { checkWhen, APPROVE_MIN_LEAD_MS } from "./validate.ts";
import { localToUtc, toLocalInput } from "./time.ts";
import { textLength } from "./bluesky.ts";
import { INSTAGRAM_CAPTION_MAX, INSTAGRAM_MAX_ITEMS, instagramSaveErrors, type InstagramDraft } from "./instagram.ts";
import type { NewPost } from "./db.ts";

export interface NewDraftFields {
  label: string; release: string; message: string; bsCaption: string; tiktokCaption?:string;
  instagramCaption?: string;
  facebook: boolean; bluesky: boolean; tiktok?: boolean; instagram?: boolean; when: string;
  contentKind?: "text" | "images" | "video";
}
export function blankNewDraft(when = ""): NewDraftFields {
  return {label:"",release:"",message:"",bsCaption:"",tiktokCaption:"",instagramCaption:"",
    facebook:true,bluesky:true,tiktok:false,instagram:false,when,contentKind:"text"};
}

/** Explicit presets only, selected through GET links. No preset approves or publishes. */
export function presetNewDraft(preset: string | null, when = ""): NewDraftFields {
  const base=blankNewDraft(when);
  if(preset==="tiktok-carousel") return {...base,facebook:false,bluesky:false,tiktok:true,contentKind:"images"};
  if(preset==="tiktok-video") return {...base,facebook:false,bluesky:false,tiktok:true,contentKind:"video"};
  // Video-first social companion to a Free Song Sunday release. The full-length
  // YouTube video and thumbnail remain a separate, owner-managed upload.
  if(preset==="free-song-sunday") return {...base,release:"Free Song Sunday",contentKind:"video"};
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
  if (!fields.facebook && !fields.bluesky && !fields.tiktok && !fields.instagram)
    throw new Error("Select at least one destination.");
  if (fields.contentKind && !["text","images","video"].includes(fields.contentKind)) throw new Error("Choose a supported content type.");
  const hasMedia = fields.contentKind === "images" || fields.contentKind === "video";
  if (fields.tiktok && !hasMedia) throw new Error("TikTok supports videos and photo carousels. Select Images or Video.");
  if (fields.instagram && !hasMedia) throw new Error("Instagram needs photos or a Reel. Select Images or Video.");
  if(fields.label.length>120 || fields.release.length>120)
    throw new Error("Name and release must each be 120 characters or fewer.");
  if(fields.message.length>63_206)
    throw new Error("Facebook caption exceeds its maximum length.");
  if(fields.tiktok && (fields.tiktokCaption?.trim()||fields.message).length>(fields.contentKind==="video"?2200:4000))
    throw new Error("TikTok caption exceeds the limit for this format.");
  if(textLength(fields.bsCaption)>300 || new TextEncoder().encode(fields.bsCaption).length>3000)
    throw new Error("Bluesky caption exceeds its 300-character limit.");
  let instagram: NewPost["instagram"] = null;
  if (fields.instagram) {
    const draft: InstagramDraft = { caption: fields.instagramCaption ?? "", frame: "4:5", items: [] };
    const errors = instagramSaveErrors(draft, new Set());
    if (errors.length) throw new Error(errors.join(" "));
    instagram = { caption: draft.caption, frame: draft.frame };
  }
  const scheduledAt=newDraftTime(fields.when,zone,now);
  return {
    message: fields.message, tiktok_caption:fields.tiktok && fields.tiktokCaption?.trim()?fields.tiktokCaption.trim():null,
    label: fields.label.trim() || null,
    release:fields.release.trim() || null,
    images:[],tiktok_images:fields.tiktok?[]:null,video:null,link:null,
    scheduled_at:scheduledAt?.toISOString() || null,
    facebook_enabled:fields.facebook,
    tiktok_enabled:fields.tiktok===true,
    bluesky:fields.bluesky ? {caption:fields.bsCaption,images:[],video:null,patreon:null} : null,
    instagram,
    created_by:"GS Poster web (via "+actor+")",
  };
}

/**
 * Platforms shown on the Destinations row but not selectable here, so the
 * pipeline is visible. Display only: the inputs are disabled and unnamed, so
 * they are never submitted and parseNewDraft never sees them.
 */
export const UPCOMING_DESTINATIONS: ReadonlyArray<{ id: string; label: string; note: string }> = [
  { id: "threads", label: "Threads", note: "Coming soon" },
  { id: "youtube", label: "YouTube", note: "Coming soon" },
  { id: "x", label: "X", note: "Open in X button on the draft page" },
];

function upcomingTile(d: { id: string; label: string; note: string }): string {
  const noteId = `upcoming-${d.id}-note`;
  return `<label class="choice-tile choice-tile-upcoming" data-upcoming="${esc(d.id)}" aria-disabled="true">`
    + `<input type="checkbox" disabled aria-describedby="${noteId}"> ${esc(d.label)}`
    + `<span class="upcoming-note" id="${noteId}">${esc(d.note)}</span></label>`;
}

export function renderNewDraft(fields:NewDraftFields,csrf:string,zone:string,error?:string):string {
  const v=(s:string)=>esc(s);
  const kind=fields.contentKind ?? "text";
  return `
  <div class="help-heading"><h2>New draft</h2>${helpTip("Saving a new draft",
    "Nothing goes live until you choose a separate publishing action.")}</div>
  ${error?`<div class="notice err" role="alert">${v(error)}</div>`:""}
  ${fields.release==="Free Song Sunday"?`<div class="notice" role="note"><strong>Free Song Sunday social video:</strong> Add a short promotional video here and tailor the captions below. This saves one unapproved GS Poster draft for the chosen social platforms. The full music video, YouTube thumbnail and YouTube upload are separate. Before approving, verify that the video is attached to each intended platform.</div>`:""}
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
  .new-file[draggable=true]{cursor:grab}
  .new-file.dragging{opacity:.45}
  .new-file.drop-target{outline:2px dashed var(--accent2);outline-offset:2px}
  .new-file label{margin:0;grid-column:2}
  .new-file input{width:100%}
  .new-file .gallery-controls{grid-column:2}
  .workspace-grid{grid-template-columns:minmax(0,1fr) minmax(210px,250px)}
  .workspace-main{min-width:0}
  .platform-editor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:12px;align-items:stretch}
  .platform-editor-grid:has(.platform-editor:not([hidden]):only-child){grid-template-columns:1fr}
  .platform-editor{min-width:0;border:1px solid var(--line);border-radius:12px;padding:16px;background:var(--bg)}
  .platform-editor h3{margin:0 0 8px}
  .platform-editor textarea{display:block;width:100%;min-width:0;min-height:210px;resize:vertical;overflow-wrap:break-word;word-break:normal}
  .platform-editor label{overflow-wrap:normal;word-break:normal}
  .platform-editor h3{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
  .platform-editor[hidden]{display:none!important}
  .platform-editor .field-meter{margin-top:5px}
  .new-target-choices{display:flex;gap:7px;flex-wrap:wrap;grid-column:2}
  .new-target-choices label{margin:0!important;font:600 12px system-ui,sans-serif;display:flex;align-items:center;gap:5px}
  .new-target-choices input{width:auto!important}
  .platform-total{font-size:12px;color:var(--muted)}
  @media(max-width:1100px){.workspace-grid{grid-template-columns:minmax(0,1fr)}.workspace-rail{position:static}}
  @media(max-width:600px){.platform-editor-grid{grid-template-columns:1fr}.platform-editor{padding:14px}}
  
  .new-file .file-title{font:600 13px/1.4 system-ui,sans-serif;min-width:0;overflow-wrap:anywhere}
  #new-video-preview{width:100%;max-height:340px;border-radius:10px;margin-top:8px}
  #new-draft-form .step-card label{margin-top:9px}
  #new-draft-form .choice-tile{margin:0!important}
  #new-draft-form .choice-tile-upcoming{opacity:.55;cursor:not-allowed;border-style:dashed;flex-wrap:wrap}
  #new-draft-form .choice-tile-upcoming .upcoming-note{flex-basis:100%;font:12px system-ui,sans-serif;color:var(--muted);margin-top:2px}
  #new-draft-form .step-card textarea{min-height:210px}
  #new-draft-status:not(:empty){margin:12px 0 0;padding:12px;border-radius:9px;background:var(--surface2)}
  #new-asap-button[aria-pressed=true]{background:var(--surface2);border-color:var(--accent2)}
  </style>
  <form class="workspace-grid" method="post" action="/new" id="new-draft-form" data-zone="${v(zone)}">
    <input type="hidden" name="csrf" value="${v(csrf)}">
    <div class="workspace-main">
      <section class="step-card" aria-labelledby="draft-platform-title">
        <h3 id="draft-platform-title" tabindex="-1">Destinations</h3>
        <div class="choice-tiles new-choice-group">
          <label class="choice-tile"><input type="checkbox" name="facebook" value="1" ${fields.facebook?"checked":""}> Facebook</label>
          <label class="choice-tile"><input type="checkbox" name="bluesky" value="1" ${fields.bluesky?"checked":""}> Bluesky</label>
          <label class="choice-tile"><input type="checkbox" name="tiktok" value="1" ${fields.tiktok?"checked":""}> TikTok</label>
          <label class="choice-tile"><input type="checkbox" name="instagram" value="1" ${fields.instagram?"checked":""}> Instagram</label>
          ${UPCOMING_DESTINATIONS.map(upcomingTile).join("")}
        </div>
      </section>

      <section class="step-card" aria-labelledby="draft-content-title">
        <h3 id="draft-content-title" tabindex="-1">Media</h3>
        <div class="choice-tiles new-choice-group" role="group" aria-label="Post content type">
          <label class="choice-tile"><input type="radio" name="content_kind" value="images" ${kind==="images"?"checked":""}> + Add photos</label>
          <label class="choice-tile"><input type="radio" name="content_kind" value="video" ${kind==="video"?"checked":""}> + Add video</label>
          <label class="choice-tile"><input type="radio" name="content_kind" value="text" ${kind==="text"?"checked":""}> Text only</label>
        </div>
        <section id="new-images-panel" ${kind!=="images"?"hidden":""}>
          ${helpTip("Image selection", `Choose destinations per photo. Facebook allows 80 photos, TikTok 35, Instagram ${INSTAGRAM_MAX_ITEMS} and Bluesky 4. Drag to reorder, or use the arrow buttons.`, "new-image-guidance")}
          <div id="new-images-drop" class="new-drop" tabindex="0" role="button" aria-label="Choose or drop images">
            <strong>Drop your artwork here</strong>
            <span>Or select JPG, PNG or GIF files, up to 10 MB each</span>
          </div>
          <input type="file" id="new-images-input" accept=".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif" multiple aria-label="Select image files">
          <p class="media-count" id="new-image-count" aria-live="polite">No images selected</p>
          <div id="new-images-preview" aria-live="polite"></div>
        </section>
        <section id="new-video-panel" ${kind!=="video"?"hidden":""}>
          ${helpTip("Video limits", "Choose one private MP4 up to 50 MB. Facebook accepts up to 20 MB for publishing.")}
          <div id="new-video-drop" class="new-drop" tabindex="0" role="button" aria-label="Choose or drop MP4 video">
            <strong>Drop your video here</strong>
            <span>Or select an MP4 file to preview, up to 50 MB</span>
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
        <h3 id="draft-copy-title" tabindex="-1">Captions</h3>
        <div class="platform-editor-grid" aria-label="Platform-specific captions">
        <section id="new-facebook-panel" class="platform-editor">
          <div class="help-heading"><h3>Facebook</h3>${helpTip("Facebook caption guidance", "Up to 63,206 characters.")}</div>
          <label for="new-message">Caption</label>
          <textarea id="new-message" name="message" maxlength="63206" placeholder="Your story, hook or announcement...">${v(fields.message)}</textarea>
          <div class="field-meter" id="new-main-count">0 characters</div>
        </section>
        <section id="new-tiktok-panel" class="platform-editor" ${fields.tiktok?"":"hidden"}>
          <div class="help-heading"><h3>TikTok</h3>${helpTip("TikTok caption guidance", "Up to 4,000 characters for photos or 2,200 for video. An empty caption uses the Facebook caption. You finish and publish inbox transfers in the TikTok app.")}</div>
          <label for="new-tiktok-caption">Caption and hashtags</label>
          <textarea id="new-tiktok-caption" name="tiktok_caption" maxlength="4000" placeholder="Tailor your TikTok caption, hooks and hashtags here...">${v(fields.tiktokCaption||"")}</textarea>
          <div class="field-meter" id="new-tiktok-count">0 characters</div>
        </section>
        <section id="new-bluesky-panel" class="platform-editor">
          <div class="help-heading"><h3>Bluesky</h3>${helpTip("Bluesky caption guidance", "Up to 300 characters. Each of the four allowed images needs alternative text.")}</div>
          <label for="new-bs">Caption</label>
          <textarea id="new-bs" name="bs_caption" maxlength="300" placeholder="A shorter companion caption...">${v(fields.bsCaption)}</textarea>
          <div class="field-meter" id="new-bs-count">0 / 300</div>
        </section>
        <section id="new-instagram-panel" class="platform-editor" ${fields.instagram?"":"hidden"}>
          <div class="help-heading"><h3>Instagram</h3>${helpTip("Instagram caption guidance", `Up to ${INSTAGRAM_CAPTION_MAX.toLocaleString("en-US")} characters. Adjust the photo framing in Studio after saving.`)}</div>
          <label for="new-ig">Caption and hashtags</label>
          <textarea id="new-ig" name="ig_caption" maxlength="${INSTAGRAM_CAPTION_MAX}">${v(fields.instagramCaption ?? "")}</textarea>
          <div class="field-meter" id="new-ig-count">0 / ${INSTAGRAM_CAPTION_MAX}</div>
        </section>
        </div>
      </section>

      <section class="step-card" aria-labelledby="draft-details-title">
        <h3 id="draft-details-title" tabindex="-1">Name and time</h3>
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
        ${helpTip("Proposed calendar time", "Facebook, Bluesky and Instagram require separate approval with your PIN. The calendar does not send TikTok inbox transfers.")}
      </section>
    </div>
    <aside class="workspace-rail" aria-label="Draft overview">
      <div class="step-card">
        <h3>Draft summary</h3>
        <div class="summary-row"><span>Destinations</span><strong id="summary-platforms">Choose platforms</strong></div>
        <div class="summary-row"><span>Format</span><strong id="summary-format">Text</strong></div>
        <div class="summary-row"><span>Media</span><strong id="summary-media">No media selected</strong></div>
        <p class="platform-total" id="new-platform-counts" aria-live="polite">Choose media for each selected platform</p>
        <div class="summary-row"><span>Calendar</span><strong id="summary-timing">Not scheduled</strong></div>
        <a id="summary-readiness" class="action-warning e" href="#draft-content-title" hidden></a>
        <div class="progress-track" role="progressbar" aria-label="Media transfer progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="new-upload-progress"><span class="progress-fill" id="new-progress-fill"></span></div>
        <p class="rail-note" id="new-progress-caption">Media will upload only after you save.</p>
        <button class="primary" type="submit" id="new-draft-submit" style="width:100%;margin-top:17px">Save draft and media</button>
        <p id="new-draft-status" role="status" aria-live="polite" class="form-info"></p>
        <a href="/" class="btn" style="display:block;text-align:center;margin-top:10px">Back to planner</a>
        <noscript><p class="action-warning">Save creates a draft. Attach media in Studio.</p></noscript>
      </div>
    </aside>
  </form>
  <script src="/new-draft.js" defer></script>
  `
}
