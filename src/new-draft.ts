/** Standalone new-draft form. Draft creation never approves or publishes. */
import { esc } from "./html.ts";
import { checkWhen, APPROVE_MIN_LEAD_MS } from "./validate.ts";
import { localToUtc, toLocalInput } from "./time.ts";
import { textLength } from "./bluesky.ts";
import type { NewPost } from "./db.ts";

export interface NewDraftFields {
  label: string; release: string; message: string; bsCaption: string;
  facebook: boolean; bluesky: boolean; when: string;
  contentKind?: "text" | "images" | "video";
}
export function blankNewDraft(when = ""): NewDraftFields {
  return {label:"",release:"",message:"",bsCaption:"",facebook:true,bluesky:true,when,contentKind:"text"};
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
  if (!fields.facebook && !fields.bluesky) throw new Error("Select Facebook, Bluesky, or both.");
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
    bluesky:fields.bluesky ? {caption:fields.bsCaption,images:[],video:null,patreon:null} : null,
    created_by:"GS Poster web (via "+actor+")",
  };
}

export function renderNewDraft(fields:NewDraftFields,csrf:string,zone:string,error?:string):string {
  const v=(s:string)=>esc(s);
  const kind=fields.contentKind ?? "text";
  return `
  <p><a href="/">← Back to calendar</a></p>
  <h2>New post draft</h2>
  <p class="hint">Choose platforms and content type, then add your captions and media. Save creates a draft only. Publishing always requires separate approval with your PIN.</p>
  ${error?`<div class="notice err" role="alert">${v(error)}</div>`:""}
  <style>
  .new-choice-group{display:flex;gap:9px;flex-wrap:wrap;margin:9px 0 15px}
  .new-choice-group label{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:9px;padding:10px 13px;margin:0;cursor:pointer}
  .new-choice-group label:has(input:checked){border-color:var(--accent2);background:color-mix(in srgb,var(--accent2) 12%,transparent)}
  #new-draft-form [hidden]{display:none!important}
  .new-drop{border:2px dashed var(--line);border-radius:9px;padding:18px;text-align:center;cursor:pointer;margin:8px 0}
  .new-drop:hover,.new-drop:focus,.new-drop.drag-over{border-color:var(--accent2);background:color-mix(in srgb,var(--accent2) 10%,transparent)}
  .new-file{border:1px solid var(--line);border-radius:8px;padding:10px;margin:8px 0;display:flex;flex-wrap:wrap;align-items:center;gap:12px}
  .new-file img{max-width:92px;max-height:92px;object-fit:cover;border-radius:6px}
  .new-file label{flex:1 1 190px;margin:0}
  .new-file input{width:100%}
  #new-video-preview{max-height:320px;max-width:100%;border-radius:8px}
  </style>
  <form class="card" method="post" action="/new" id="new-draft-form" data-zone="${v(zone)}">
    <input type="hidden" name="csrf" value="${v(csrf)}">
    <h3>1. Publishing platforms</h3>
    <div class="new-choice-group">
      <label><input type="checkbox" name="facebook" value="1" ${fields.facebook?"checked":""}> Facebook</label>
      <label><input type="checkbox" name="bluesky" value="1" ${fields.bluesky?"checked":""}> Bluesky</label>
    </div>
    <p class="hint">TikTok integration is planned, but not yet connected. No post will be sent there.</p>
    <h3>2. Content type</h3>
    <div class="new-choice-group" role="group" aria-label="Post content type">
      <label><input type="radio" name="content_kind" value="text" ${kind==="text"?"checked":""}> Text</label>
      <label><input type="radio" name="content_kind" value="images" ${kind==="images"?"checked":""}> Images</label>
      <label><input type="radio" name="content_kind" value="video" ${kind==="video"?"checked":""}> Video</label>
    </div>
    <section id="new-images-panel" ${kind!=="images"?"hidden":""}>
      <h3>Images</h3>
      <p class="hint">JPG, PNG or GIF, 10 MB each. Up to 4 if posting to Bluesky. Add an image description when Bluesky is selected.</p>
      <div id="new-images-drop" class="new-drop" tabindex="0" role="button" aria-label="Choose or drop images">
        Drop images here or select files
      </div>
      <input type="file" id="new-images-input" accept=".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif" multiple aria-label="Select image files">
      <div id="new-images-preview" aria-live="polite"></div>
    </section>
    <section id="new-video-panel" ${kind!=="video"?"hidden":""}>
      <h3>Video</h3>
      <p class="hint">One MP4, maximum 20 MB. A video cannot be combined with an image gallery on the same platform.</p>
      <div id="new-video-drop" class="new-drop" tabindex="0" role="button" aria-label="Choose or drop MP4 video">
        Drop MP4 here or select a file
      </div>
      <input type="file" id="new-video-input" accept=".mp4,video/mp4" aria-label="Select video file">
      <video id="new-video-preview" controls playsinline preload="metadata" hidden></video>
      <p id="new-video-name" class="hint"></p>
      <label id="new-video-alt-label" for="new-video-alt">Video accessibility description for Bluesky
        <input type="text" id="new-video-alt" maxlength="1000" placeholder="Describe what the video shows">
      </label>
    </section>
    <h3>3. Captions</h3>
    <section id="new-facebook-panel">
      <label for="new-message">Facebook caption</label>
      <textarea id="new-message" name="message" maxlength="63206" placeholder="Write your caption, or add it before approval.">${v(fields.message)}</textarea>
    </section>
    <section id="new-bluesky-panel">
      <label for="new-bs">Bluesky caption (maximum 300 characters)</label>
      <textarea id="new-bs" name="bs_caption" maxlength="300" style="min-height:110px" placeholder="Write your Bluesky caption, or add it before approval.">${v(fields.bsCaption)}</textarea>
    </section>
    <h3>4. Post details and proposed time</h3>
    <label for="new-label">Post name (optional)</label>
    <input id="new-label" name="label" type="text" maxlength="120" value="${v(fields.label)}" placeholder="House Rule Compendium video">
    <label for="new-release">Release or collection (optional)</label>
    <input id="new-release" name="release" type="text" maxlength="120" value="${v(fields.release)}">
    <label for="new-when">Proposed release time (${v(zone)})</label>
    <input type="hidden" name="asap" id="new-asap" value="0">
    <div class="row" style="align-items:center;gap:9px;flex-wrap:wrap">
      <input id="new-when" type="datetime-local" name="when" value="${v(fields.when)}" style="flex:1;min-width:190px">
      <button id="new-asap-button" type="button" aria-pressed="false">As soon as possible (+12 min)</button>
    </div>
    <p class="hint">Choose a time at least 12 minutes away and within 30 days, or leave blank for publication upon later approval. Saving is never approval.</p>
    <div class="row"><button class="primary" type="submit" id="new-draft-submit">Save draft and media</button><a href="/" class="btn">Cancel</a></div>
    <div id="new-draft-status" role="status" aria-live="polite" class="hint"></div>
    <p class="hint">If scripts are disabled, Save creates the text draft and you can attach media on its review page.</p>
  </form>
  <script src="/new-draft.js" defer></script>
  `;
}
