import {test} from "node:test";
import assert from "node:assert/strict";
import {pr90StagingAllowed as allowed} from "../src/pr90-staging-policy.ts";

test("staging entry refuses every approval, publishing and retry mutation",()=>{
  for(const action of ["approve","reject","redraft","retry-facebook","retry-bluesky",
    "tiktok-send","tiktok-upload","tiktok-options","tiktok-status","tiktok-redraft",
    "instagram-cancel","instagram-retry","instagram-close","reschedule","edit-caption",
    "resume-facebook","abandon-facebook","reconcile-facebook","reconcile-stuck",
    "restore-cancelled","tiktok-clear"]){
    assert.equal(allowed("POST","/post/p_example/"+action),false,action);
  }
  for(const path of ["/mcp","/mcp/","/token","/register","/authorize","/revoke"]){
    for(const method of ["GET","POST"])assert.equal(allowed(method,path),false,method+" "+path);
  }
  assert.equal(allowed("DELETE","/post/p_example/save"),false);
});

test("staging permits only draft editing and one-time private media transfer",()=>{
  for(const path of ["/post/p_example/save","/post/p_example/return-to-drafts",
    "/post/p_example/video-link","/post/p_example/attach-video",
    "/post/p_example/import-video","/post/p_example/upload-link",
    "/post/p_example/attach-image","/post/p_example/import-tiktok-image","/new"])
    assert.equal(allowed("POST",path),true,path);
  const grant="/upload/"+"a".repeat(32)+"/"+"s".repeat(32);
  assert.equal(allowed("PUT",grant),true);
  assert.equal(allowed("POST",grant),false);
  assert.equal(allowed("PUT","/upload/nope/not-a-token"),false);
  assert.equal(allowed("GET","/health"),true);
  assert.equal(allowed("GET","/calendar?view=month"),true);
});
