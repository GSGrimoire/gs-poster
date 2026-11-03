/**
 * Read-only pre-publish review checks.
 * These are editorial heuristics, never publish gates and never mutations.
 * Opening excerpts are intentionally NOT claimed as platform truncation limits.
 */
import {esc} from "./html.ts";
import type {Post} from "./db.ts";
import {tiktokMedia} from "./db.ts";
import {countHashtags,INSTAGRAM_HASHTAG_MAX} from "./instagram.ts";
import {mediaLooksPending} from "./validate.ts";

export type ReviewPlatform="facebook"|"bluesky"|"tiktok"|"instagram";
export interface EditorialFinding {kind:"warning"|"note";message:string}
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
  const warn=(message:string)=>findings.push({kind:"warning",message});
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
  if(opts.pending&&!opts.hasMedia)warn("The post name suggests media is pending, but this platform has no media.");
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
  if(platform==="instagram"&&hashtags.length>INSTAGRAM_HASHTAG_MAX)
    warn("Instagram allows at most "+INSTAGRAM_HASHTAG_MAX+" hashtags; found "+hashtags.length+".");
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

/** Accessible, escaped, bounded markup. No actions or inputs in the review panel. */
export function renderEditorialReview(post:Post):string{
  const reports=editorialReview(post);
  if(!reports.length)return "";
  const rows=reports.map(r=>`
    <section class="preflight-target" aria-label="${esc(r.label)} caption review">
      <h4>${esc(r.label)} <span class="hint">${r.hashtagCount} hashtags</span></h4>
      <p class="hint">Opening ${r.previewCharacters} characters (illustrative excerpt, not a verified platform cutoff):</p>
      <blockquote class="preflight-excerpt">${esc(r.opening || "(empty caption)")}${r.captionLength>r.previewCharacters?"…":""}</blockquote>
      ${r.findings.length?`<ul class="checks">${r.findings.map(f=>
        `<li class="${f.kind==="warning"?"w":"note"}">${esc(f.message)}</li>`).join("")}</ul>`
        :'<p class="hint">No additional editorial warnings found.</p>'}
    </section>`).join("");
  const count=reports.reduce((n,r)=>n+r.findings.filter(f=>f.kind==="warning").length,0);
  return `<section class="preflight-panel" id="preflight-panel" aria-labelledby="preflight-heading">
    <h3 id="preflight-heading">Pre-publish review</h3>
    <p class="hint">Read-only checks of the last saved draft, including Instagram preparation.
      These are editorial prompts, not platform acceptance tests. They never publish or block approval.</p>
    <p class="hint">${count} editorial warning${count===1?"":"s"} across ${reports.length} selected platform${reports.length===1?"":"s"}.</p>
    <p class="hint" id="preflight-stale" hidden>Saved content changed since this review loaded.
      Reload this page before final approval to review the latest captions.</p>
    ${rows}
  </section>`;
}
