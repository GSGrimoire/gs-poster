import {test} from "node:test";
import assert from "node:assert/strict";
import {page} from "../src/html.ts";
import {blankNewDraft,presetNewDraft,renderNewDraft} from "../src/new-draft.ts";
import {NEW_DRAFT_JS} from "../src/new-draft-client.ts";
import {renderCalendar} from "../src/calendar.ts";
import type {Post} from "../src/db.ts";
import type {Env} from "../src/env.ts";

test("editorial shell gives signed-in users accessible shortcuts without exposing them publicly",()=>{
  const shell=page("New draft","<p>Workspace</p>",{login:"Reviewer"});
  assert.match(shell,/<nav class="app-nav" aria-label="Workspace navigation">/);
  assert.match(shell,/href="\/new" class="nav-create" aria-current="page"/);
  assert.match(shell,/<main id="main-content">/);
  assert.match(shell,/prefers-reduced-motion/);
  assert.match(shell,/:focus-visible/);
  const publicPage=page("Terms","<p>Public page</p>",{public:true});
  assert.doesNotMatch(publicPage,/Workspace navigation/);
  assert.doesNotMatch(publicPage,/Signed in as/);
});

test("new draft keeps server-side safety while exposing four steps and a responsive overview",()=>{
  const fields={...blankNewDraft(),facebook:false,bluesky:false,tiktok:true,contentKind:"images" as const};
  const html=renderNewDraft(fields,"csrf-unsafe<&","Europe/Copenhagen");
  assert.match(html,/class="workspace-grid"[^>]*id="new-draft-form"/);
  assert.match(html,/id="draft-platform-title"/);
  assert.match(html,/id="draft-content-title"/);
  assert.match(html,/id="draft-copy-title"/);
  assert.match(html,/id="draft-details-title"/);
  for(const id of ["new-images-preview","new-image-count","new-image-guidance","summary-platforms",
     "summary-format","summary-media","summary-timing","summary-readiness",
     "new-upload-progress","new-progress-fill","new-draft-status","new-main-count",
     "new-bs-count","new-clear-time","new-asap-button"]) {
    assert.match(html,new RegExp('id="'+id+'"'),id+" must be present");
  }
  assert.match(html,/name="tiktok" value="1" checked/);
  assert.match(html,/name="content_kind" value="images" checked/);
  assert.match(html,/name="csrf" value="csrf-unsafe&#60;&#38;"/);
  assert.match(html,/Nothing goes live until you choose a separate publishing action/);
  assert.doesNotMatch(html,/name="pin"|action="[^"]*\/approve"/);
});

test("image carousel editor preserves order and alternate descriptions when reordering",()=>{
  assert.match(NEW_DRAFT_JS,/function renumberImages\(\)/);
  assert.match(NEW_DRAFT_JS,/images\.splice\(index,1\)/);
  assert.match(NEW_DRAFT_JS,/images\.splice\(next,0,item\)/);
  assert.match(NEW_DRAFT_JS,/imageList\.replaceChildren\(\.\.\.images\.map\(item=>item\.wrap\)\)/);
  assert.match(NEW_DRAFT_JS,/item\.label\.firstChild\.textContent/);
  assert.match(NEW_DRAFT_JS,/action\("Move up",-1\)/);
  assert.match(NEW_DRAFT_JS,/action\("Move down",1\)/);
  assert.match(NEW_DRAFT_JS,/action\("Remove",null\)/);
  assert.match(NEW_DRAFT_JS,/const tt=target\("tiktok"\)/);
  assert.match(NEW_DRAFT_JS,/form\.querySelector\('input\[name="content_kind"\]\[value="images"\]'\)\.checked=true/);
  assert.match(NEW_DRAFT_JS,/images\.filter\(x=>x\.attached\)\.length/);
  assert.match(NEW_DRAFT_JS,/new-upload-progress/);
  assert.match(NEW_DRAFT_JS,/const platformLimits=\{facebook:80,tiktok:35,bluesky:4\}/);
  assert.match(NEW_DRAFT_JS,/selectedCount\(name\)/);
  assert.match(NEW_DRAFT_JS,/item.order<4/);
  assert.match(NEW_DRAFT_JS,/item.order<35/);
  assert.doesNotMatch(NEW_DRAFT_JS,/\/approve|\/publish/);
});

test("calendar shows TikTok destination without suggesting automatic TikTok publication",()=>{
  const post={
    id:"p_tiktok123",label:"Carousel",release:null,created_by:"Reviewer",
    created_at:"2026-10-27T10:00:00.000Z",
    updated_at:"2026-10-28T10:00:00.000Z",
    scheduled_at:"2026-10-29T15:00:00.000Z",
    status:"draft",facebook_enabled:false,tiktok_enabled:true,bluesky:null,
    message:"Carousel about ancient artifacts",images:["upload://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"],
  } as unknown as Post;
  const html=renderCalendar(
    {TIMEZONE:"Europe/Copenhagen"} as Env,[post],"csrf","2026-10-25",new Date("2026-10-28T09:00:00.000Z")
  );
  assert.match(html,/platform-icon tiktok/);
  assert.match(html,/TikTok requires an explicit transfer/);
  assert.match(html,/aria-label="TikTok"/);
  assert.match(html,/data-status="draft"/);
});

test("TikTok quick starts do not silently select Facebook or Bluesky",()=>{
  const when="2026-10-30T12:00";
  const photo=presetNewDraft("tiktok-carousel",when);
  assert.equal(photo.contentKind,"images");
  assert.equal(photo.tiktok,true);
  assert.equal(photo.facebook,false);
  assert.equal(photo.bluesky,false);
  assert.equal(photo.when,when);
  const video=presetNewDraft("tiktok-video",when);
  assert.equal(video.contentKind,"video");
  assert.equal(video.facebook,false);
  assert.equal(video.bluesky,false);
  assert.equal(video.tiktok,true);
  assert.deepEqual(presetNewDraft("unknown"),blankNewDraft());
});
