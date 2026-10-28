import {test} from "node:test";
import assert from "node:assert/strict";
import {publicPage,tiktokCallbackPlaceholder} from "../src/public-pages.ts";
import {page} from "../src/html.ts";

test("public terms, privacy and service description have no login requirement or noindex",async()=>{
  for(const which of ["about","terms","privacy"] as const) {
    const res=publicPage(which);
    assert.equal(res.status,200);
    assert.match(res.headers.get("Content-Type")||"",/text\/html/);
    const body=await res.text();
    assert.match(body,/<html lang="en">/);
    assert.doesNotMatch(body,/name="robots" content="noindex/);
    assert.match(body,/href="\/terms"/);
    assert.match(body,/href="\/privacy"/);
    assert.match(body,/href="\/about"/);
    assert.doesNotMatch(body,/fb_page_token|FB_PAGE_TOKEN|access_token=/i);
  }
});
test("privacy page discloses encrypted TikTok account authorization and manual inbox transfer",async()=>{
  const text=await publicPage("privacy").text();
  for(const phrase of ["GitHub","Cloudflare","Facebook","Bluesky","45-day","TikTok","request","session cookies"])
    assert.ok(text.includes(phrase), "Missing policy section: "+phrase);
  assert.match(text,/If an editor connects TikTok/);
  assert.match(text,/completes publication inside TikTok/);
});
test("public terms explain human review, media responsibility and third party rules",async()=>{
  const text=await publicPage("terms").text();
  assert.match(text,/separately approve publication/);
  assert.match(text,/copyright/);
  assert.match(text,/Third-party processing/);
});
test("TikTok callback is a nonfunctional safe placeholder, never echoes sensitive query",async()=>{
  const url="https://gs-poster.goofyspook.workers.dev/tiktok/callback?code=secret-auth-code&state=secret-state";
  const response=tiktokCallbackPlaceholder(new Request(url));
  assert.equal(response.status,503);
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  const body=await response.text();
  assert.match(body,/connection not configured/i);
  assert.doesNotMatch(body,/secret-auth-code|secret-state|access_token/);
  assert.doesNotMatch(body,/name="robots" content="noindex/);
  const bare=tiktokCallbackPlaceholder(new Request("https://gs-poster.goofyspook.workers.dev/tiktok/callback"));
  assert.equal(bare.status,200,"The exact registered callback is reachable without auth credentials.");
  const method=tiktokCallbackPlaceholder(new Request(url,{method:"POST"}));
  assert.equal(method.status,405);
  assert.equal(method.headers.get("Allow"),"GET");
});
test("admin pages remain noindexed and linked to public policies",()=>{
  const html=page("Post details","Private content",{login:"authorized"});
  assert.match(html,/noindex,nofollow/);
  assert.match(html,/href="\/privacy"/);
  assert.match(html,/href="\/terms"/);
});
