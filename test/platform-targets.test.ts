// Platform rules registry and the per-platform editor cards. The editor moved
// captions and media into one card per platform; the form field names the
// server parses must not change, and the live checks must agree with the
// server's limits.
import {test} from "node:test";
import assert from "node:assert/strict";
import {captionLimit,checkTarget,PLATFORMS,TIKTOK_PHOTO_MAX} from "../src/platforms.ts";
import {renderDraftEditor,targetStates,DRAFT_EDITOR_JS,parseEditorForm} from "../src/draft-editor.ts";
import {BSKY_IMAGE_COUNT,BSKY_TEXT_LIMIT} from "../src/bluesky.ts";
import {MAX_IMAGES} from "../src/validate.ts";

test("registry limits match the limits the server already enforces",()=>{
  assert.equal(PLATFORMS.facebook.maxPhotos,MAX_IMAGES);
  assert.equal(PLATFORMS.bluesky.maxPhotos,BSKY_IMAGE_COUNT);
  assert.equal(PLATFORMS.bluesky.caption.photo,BSKY_TEXT_LIMIT);
  assert.equal(TIKTOK_PHOTO_MAX,35);
  assert.equal(captionLimit("tiktok",{photos:3,video:false}),4000);
  assert.equal(captionLimit("tiktok",{photos:0,video:true}),2200);
});

test("checkTarget: hard limits are errors, display shape is only a note",()=>{
  const base={captionLength:10,photos:2,video:false,missingAlt:0};
  assert.deepEqual(checkTarget({id:"facebook",...base}).errors,[]);
  assert.match(checkTarget({id:"bluesky",...base,photos:5}).errors[0],/allows 4/);
  assert.match(checkTarget({id:"bluesky",...base,missingAlt:1}).errors[0],/description is missing/);
  assert.match(checkTarget({id:"bluesky",...base,captionLength:301}).errors[0],/allows 300/);
  assert.match(checkTarget({id:"tiktok",...base,photos:0}).errors[0],/needs photos or a video/);
  assert.match(checkTarget({id:"facebook",...base,photos:1,video:true}).errors[0],/cannot go in the same post/);
  assert.match(checkTarget({id:"tiktok",...base,video:true,photos:0,captionLength:2201}).errors[0],/allows 2200/);
  const shape=checkTarget({id:"tiktok",...base,ratios:[1,0.5625]});
  assert.deepEqual(shape.errors,[]);
  assert.equal(shape.warnings.length,1);
  assert.match(shape.warnings[0],/1 photo is outside 9:16/);
  assert.deepEqual(checkTarget({id:"facebook",...base,ratios:[1,0.8,1.91]}).warnings,[]);
});

const post:any={id:"p_x",status:"draft",label:"Cave",release:null,message:"Free in the Archive: patreon.com/GSGrimoire",
  tiktok_caption:null,images:["a","b"],tiktok_images:null,video:null,tiktok_video:null,facebook_enabled:true,tiktok_enabled:true,
  scheduled_at:null,updated_at:"2026-11-01T20:00:00.000Z",created_at:"2026-11-01T19:00:00.000Z",note:null,approved_at:null,link:null,
  bluesky:{caption:"Cave",images:[{url:"a",alt:"A cave"},{url:"b",alt:" "}],video:null,patreon:null}};
const html=renderDraftEditor({post,csrf:"t",tz:"Europe/Copenhagen",whenText:"On approval",checksHtml:"",releaseProblems:[],
  mediaPanel:"",tiktokCard:"",mediaLooksPending:false,createdLine:""});

test("one card per platform, each with its own caption, media and checks",()=>{
  for(const id of ["facebook","bluesky","tiktok"]){
    assert.match(html,new RegExp(`<article class="target" id="target-${id}" data-platform="${id}"`));
    assert.match(html,new RegExp(`data-checks="${id}"`));
    assert.match(html,new RegExp(`data-media="${id}"`));
    assert.match(html,new RegExp(`href="#target-${id}"`));
  }
  assert.match(html,/data-shared="facebook"/,"TikTok shared gallery points at the Facebook tiles");
  assert.match(html,/1 description is missing/,"first render already shows the Bluesky problem");
  assert.match(html,/not the crop a platform will deliver/);
});

test("form field names the server parses are unchanged",()=>{
  for(const name of ["message","bs_caption","tiktok_caption","p_facebook","p_bluesky","p_tiktok",
    "remove_fb_0","remove_fb_1","remove_bs_0","bs_alt_0","bs_alt_1","bs_patreon_url","label","release","when","expected_updated_at","csrf"])
    assert.match(html,new RegExp(`name="${name}"`),name);
  const f=new FormData();
  for(const [k,v] of [["p_facebook","1"],["p_bluesky","1"],["p_tiktok","1"],["message","New"],["bs_caption","Hi"],
    ["bs_alt_0","A cave"],["bs_alt_1","Second"],["remove_fb_1","1"]])f.set(k,v);
  const parsed=parseEditorForm(f,post,"Europe/Copenhagen");
  assert.deepEqual(parsed.errors,[]);
  assert.deepEqual(parsed.next!.images,["a"]);
  assert.equal(parsed.bluesky!.images[1].alt,"Second");
});

test("rules reach the browser as JSON and the script reads them",()=>{
  const m=html.match(/data-rules="([^"]+)"/);
  assert.ok(m);
  const json=JSON.parse(m[1].replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n))));
  assert.equal(json.bluesky.maxPhotos,4);
  assert.match(DRAFT_EDITOR_JS,/dataset\.rules/);
  assert.doesNotThrow(()=>new Function(DRAFT_EDITOR_JS));
});

test("targetStates counts what the server would save",()=>{
  const s=targetStates(post);
  assert.equal(s.facebook.photos,2);
  assert.equal(s.bluesky.missingAlt,1);
  assert.equal(s.tiktok.photos,2,"shared fallback uses the Facebook photos");
  assert.equal(s.tiktok.captionLength,post.message.length,"empty TikTok caption reuses Facebook's");
});
