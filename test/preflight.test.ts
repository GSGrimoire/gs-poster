import {test} from "node:test";
import assert from "node:assert/strict";
import {editorialReview,renderEditorialReview,OPENING_EXCERPT_CHARACTERS} from "../src/preflight.ts";
import type {Post} from "../src/db.ts";

const BASE={
  id:"p_test",message:"At the Archive, find winter cave maps. Download the free pack.",
  label:"Winter cave",release:"Winter cave",
  facebook_enabled:true,tiktok_enabled:true,tiktok_images:[],tiktok_video:null,video:null,images:[],
  bluesky:{caption:"Winter cave maps in the Archive.",images:[],video:null},
  instagram:{caption:"Winter cave maps.",frame:"4:5",items:[]},
};
const post=(overrides:Record<string,unknown>={}):Post=>({...BASE,...overrides} as unknown as Post);
const selected=(p:Post,id:string)=>editorialReview(p).find(x=>x.platform===id)!;

test("panel covers only currently selected platforms and separates Instagram manual preparation",()=>{
  const p=post();
  assert.deepEqual(editorialReview(p).map(r=>r.platform),["facebook","bluesky","tiktok","instagram"]);
  assert.equal(selected(p,"instagram").label,"Instagram (manual)");
  assert.deepEqual(editorialReview(post({facebook_enabled:false,tiktok_enabled:false,bluesky:null,instagram:null})),[]);
  assert.match(renderEditorialReview(p),/Pre-publish review/);
  assert.match(renderEditorialReview(p),/never publish or block approval/);
});

test("opening excerpt is explicit and does not pretend to predict the platforms' truncation",()=>{
  const text="a".repeat(240);
  const p=post({message:text,instagram:{...BASE.instagram,caption:text}});
  const fb=selected(p,"facebook"),ig=selected(p,"instagram");
  assert.equal(fb.opening.length,OPENING_EXCERPT_CHARACTERS.facebook);
  assert.equal(ig.opening.length,125);
  assert.equal(ig.captionLength,240);
  const html=renderEditorialReview(p);
  assert.match(html,/illustrative excerpt, not a verified platform cutoff/);
});

test("flags TikTok hashtag guidance, prohibited hashtags and missing collection search terms",()=>{
  const p=post({message:"Night descent! Visit the Archive. Follow for more. #fyp #Viral #cave #map #dnd",
    tiktok_caption:null});
  const findings=selected(p,"tiktok").findings.map(f=>f.message).join(" ");
  assert.match(findings,/2 to 4 relevant hashtags; found 5/);
  assert.match(findings,/#fyp, #viral/);
  assert.match(findings,/Several calls to action/);
  assert.match(findings,/Collection name is absent/);
  assert.equal(selected(p,"facebook").hashtagCount,5);
});

test("flags invisible characters, em dash, missing media and excessive Instagram hashtags",()=>{
  const p=post({message:"Artifact\u2014new\u200b kit.",
    label:"Images pending",release:"Winter cave",
    instagram:{...BASE.instagram,caption:"Caption #one #two #three #four #five #six"}});
  const facebook=selected(p,"facebook").findings.map(f=>f.message).join(" ");
  assert.match(facebook,/An em dash/);
  assert.match(facebook,/Invisible or soft-hyphen/);
  assert.match(facebook,/media is pending/);
  assert.match(selected(p,"bluesky").findings.map(f=>f.message).join(" "),/media is pending/);
  assert.match(selected(p,"instagram").findings.map(f=>f.message).join(" "),/at most 5 hashtags/);
});

test("TikTok inbox videos flag that final caption is entered inside TikTok",()=>{
  const p=post({tiktok_video:"upload://"+"f".repeat(32)+".mp4"});
  assert.match(selected(p,"tiktok").findings.map(f=>f.message).join(" "),/caption inside TikTok/);
});

test("all user-controlled captions and labels in panel are escaped",()=>{
  const malicious='The <img src=x onerror=alert(1)> "\"danger\" & content';
  const p=post({message:malicious,release:'<b>release</b>'});
  const html=renderEditorialReview(p);
  assert.doesNotMatch(html,/<img src=x/);
  assert.doesNotMatch(html,/<b>release/);
  assert.match(html,/&#60;img/);
  assert.match(html,/&#38;/);
});
