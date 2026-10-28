/** Standalone new-draft form. Draft creation never approves or publishes. */
import { esc } from "./html.ts";
import { checkWhen, APPROVE_MIN_LEAD_MS } from "./validate.ts";
import { localToUtc, toLocalInput } from "./time.ts";
import { textLength } from "./bluesky.ts";
import type { NewPost } from "./db.ts";

export interface NewDraftFields {
  label: string; release: string; message: string; bsCaption: string;
  facebook: boolean; bluesky: boolean; when: string;
}
export function blankNewDraft(when = ""): NewDraftFields {
  return {label:"",release:"",message:"",bsCaption:"",facebook:true,bluesky:true,when};
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
export function newDraftPrefill(value: string | null, zone: string, now = new Date()): string {
  if(!value)return "";
  try{newDraftTime(value,zone,now);return value;}catch{return "";}
}
export function parseNewDraft(
  fields: NewDraftFields, zone: string, actor: string, now = new Date(),
): NewPost {
  if (!fields.facebook && !fields.bluesky) throw new Error("Select Facebook, Bluesky, or both.");
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
  return `<p><a href="/">← Back to calendar</a></p>
    <h2>New post draft</h2>
    <p class="hint">Save the draft first, then upload images or a video on its review page. Saving does not approve, schedule or publish anything. Your PIN is required later.</p>
    ${error?`<div class="notice err" role="alert">${v(error)}</div>`:""}
    <form class="card" method="post" action="/new">
      <input type="hidden" name="csrf" value="${v(csrf)}">
      <label for="new-label">Post name (optional)</label>
      <input id="new-label" name="label" type="text" maxlength="120" value="${v(fields.label)}" placeholder="House Rule Compendium video">
      <label for="new-release">Release or collection (optional)</label>
      <input id="new-release" name="release" type="text" maxlength="120" value="${v(fields.release)}">
      <div class="row">
        <label><input type="checkbox" name="facebook" value="1" ${fields.facebook?"checked":""}> Facebook</label>
        <label><input type="checkbox" name="bluesky" value="1" ${fields.bluesky?"checked":""}> Bluesky</label>
      </div>
      <label for="new-message">Facebook caption (can be added later)</label>
      <textarea id="new-message" name="message" maxlength="63206" placeholder="Write a caption, or add it before approval.">${v(fields.message)}</textarea>
      <label for="new-bs">Bluesky caption (can be added later)</label>
      <textarea id="new-bs" name="bs_caption" maxlength="300" style="min-height:110px" placeholder="Up to 300 characters">${v(fields.bsCaption)}</textarea>
      <label for="new-when">Proposed release time (${v(zone)})</label>
      <input id="new-when" type="datetime-local" name="when" value="${v(fields.when)}">
      <p class="hint">This is only a proposed time. Choose a slot at least 12 minutes away and no more than 30 days ahead. Leave blank to publish only when you later approve.</p>
      <div class="row"><button class="primary" type="submit">Save draft</button><a href="/" class="btn">Cancel</a></div>
    </form>`;
}
