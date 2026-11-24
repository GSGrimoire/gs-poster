/**
 * Read-only pre-publish review checks.
 * These are editorial heuristics, never publish gates and never mutations.
 * Opening excerpts are intentionally NOT claimed as platform truncation limits.
 */
import {actionWarning,esc,helpTip} from "./html.ts";
import {STUDIO_CAPTION_IDS} from "./platforms.ts";
import type {Post} from "./db.ts";
import {tiktokMedia} from "./db.ts";
/** Instagram app guidance since December 2025; the developer API still lists 30. */
export const INSTAGRAM_EDITORIAL_HASHTAGS=5;
import {mediaLooksPending} from "./validate.ts";

export type ReviewPlatform="facebook"|"bluesky"|"tiktok"|"instagram";
export interface EditorialFinding {kind:"warning"|"note";message:string;field?:"media"}
export interface EditorialReview {
  platform:ReviewPlatform;label:string;
  opening:string;previewCharacters:number;captionLength:number;hashtagCount:number;
  findings:EditorialFinding[];
}
export const OPENING_EXCERPT_CHARACTERS:Readonly<Record<ReviewPlatform,number>>={
  facebook:160,bluesky:160,tiktok:160,instagram:125,
};
const BAD_TAGS=new Set(["fyp","foryou","viral","trending"]);
const TAGS=/(?:^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]+)/gu;
const INVISIBLE=/[\u00ad\u200b-\u200d\u2060\ufeff]/u;
const CTA_GROUPS=[
  /\b(follow|subscribe)\b/i,
  /\b(save|bookmark)\b/i,
  /\b(share|send to a friend)\b/i,
  /\b(comment|tell us|reply)\b/i,
  /\b(visit|check out|open|link in bio|patreon\.com)\b/i,
  /\b(download|grab|get your copy)\b/i,
];
function scan(platform:ReviewPlatform,label:string,caption:string,opts:{
  hasMedia:boolean;pending:boolean;searchPhrase?:string|null;video?:boolean;
}):EditorialReview{
  const findings:EditorialFinding[]=[];
  const warn=(message:string,field?:"media")=>findings.push({kind:"warning",message,field});
  const note=(message:string)=>findings.push({kind:"note",message});
  const n=OPENING_EXCERPT_CHARACTERS[platform];
  const opening=caption.slice(0,n);
  const hashtags=[...caption.matchAll(TAGS)].map(m=>m[1].toLowerCase());
  const banned=[...new Set(hashtags.filter(x=>BAD_TAGS.has(x)))];
  const asks=CTA_GROUPS.filter(re=>re.test(caption)).length;
  if(asks>1)warn("Several calls to action appear in the caption. Consider one primary request.");
  if(banned.length)warn("Review prohibited generic hashtags: "+banned.map(x=>"#"+x).join(", ")+".");
  if(caption.includes("\u2014"))warn("An em dash is present; the house rule prohibits it.");
  if(INVISIBLE.test(caption))warn("Invisible or soft-hyphen characters detected; remove unintended formatting.");
  if(opts.pending&&!opts.hasMedia)warn("The post name suggests media is pending, but this platform has no media.","media");
  if(platform==="tiktok"){
    if(hashtags.length<2||hashtags.length>4)
      warn("TikTok house guidance is 2 to 4 relevant hashtags; found "+hashtags.length+".");
    if(opts.video)note("TikTok inbox videos receive their caption inside TikTok, not from this transfer.");
    if(opts.searchPhrase?.trim()){
      const phrase=opts.searchPhrase.trim();
      if(!opening.toLocaleLowerCase().includes(phrase.toLocaleLowerCase()))
        note("Collection name is absent from this opening excerpt. Check the intended search phrase manually.");
    }else{
      note("No search phrase is recorded for this draft. Confirm the opening line contains your intended search terms.");
    }
  }
  if(platform==="instagram"&&hashtags.length>INSTAGRAM_EDITORIAL_HASHTAGS)
    warn("Instagram app guidance is at most "+INSTAGRAM_EDITORIAL_HASHTAGS+
      " hashtags; found "+hashtags.length+". The publishing API has a separate documented limit.");
  if(!caption.trim())note("No caption is saved for this platform.");
  return {platform,label,opening,previewCharacters:n,captionLength:caption.length,
    hashtagCount:hashtags.length,findings};
}

/** Only saved, currently selected targets appear. Paused targets stay out of review. */
export function editorialReview(post:Post):EditorialReview[]{
  const pending=mediaLooksPending(post.label,post.release);
  const tt=tiktokMedia(post);
  const reports:EditorialReview[]=[];
  if(post.facebook_enabled)reports.push(scan("facebook","Facebook",post.message,
    {hasMedia:!!post.video||post.images.length>0,pending}));
  if(post.bluesky)reports.push(scan("bluesky","Bluesky",post.bluesky.caption,
    {hasMedia:!!post.bluesky.video||post.bluesky.images.length>0,pending}));
  if(post.tiktok_enabled)reports.push(scan("tiktok","TikTok",post.tiktok_caption??post.message,
    {hasMedia:!!tt.video||tt.images.length>0,pending,searchPhrase:post.release,video:!!tt.video}));
  if(post.instagram)reports.push(scan("instagram","Instagram (manual)",post.instagram.caption,
    {hasMedia:!!post.instagram.video||post.instagram.items.length>0,pending}));
  return reports;
}

/** Saved editorial warnings stay visible; preview and advice are optional. */
export function renderEditorialReview(post:Post):string{
  const reports=editorialReview(post);
  if(!reports.length)return "";
  const warnings=reports.flatMap(report=>report.findings.filter(f=>f.kind==="warning").map(f=>
    `<li>${actionWarning(report.label + " · " + f.message,
      f.field === "media" ? "#ed-media" : "#" + STUDIO_CAPTION_IDS[report.platform])}</li>`)).join("");
  return `<section class="preflight-panel" id="preflight-panel" aria-labelledby="preflight-heading">
    <div class="help-heading"><h3 id="preflight-heading">Pre-publish review</h3>
      ${helpTip("Editorial review", "Prompts based on the last saved draft. Editorial checks never publish or block approval.")}</div>
    <p class="action-warning" id="preflight-stale" role="status" hidden>Reload to check the latest saved captions.</p>
    <ul class="action-checks">${warnings}</ul>
    <details><summary>Caption previews and notes</summary>
      ${reports.map(r=>`<section class="preflight-target" aria-label="${esc(r.label)} caption review">
        <h4>${esc(r.label)} <span class="hint">${r.hashtagCount} hashtags</span></h4>
        <p class="hint">Opening ${r.previewCharacters} characters (illustrative excerpt, not a verified platform cutoff)</p>
        <blockquote class="preflight-excerpt">${esc(r.opening || "(empty caption)")}${r.captionLength>r.previewCharacters?"…":""}</blockquote>
        ${r.findings.filter(f=>f.kind==="note").map(f=>`<p class="hint">${esc(f.message)}</p>`).join("")}
      </section>`).join("")}
    </details>
  </section>`;
}
