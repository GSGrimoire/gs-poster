/**
 * Real Chromium acceptance against the bundled production editor and planner
 * running in Miniflare. The HTTPS origin is fulfilled by Playwright routing:
 * no public server, real account, or provider credentials are involved.
 * Screenshots and JSON results are CI artifacts, not live Cloudflare evidence.
 */
import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {chromium} from "playwright";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema,getPost} from "../src/db.ts";
import {makeSession,SESSION_COOKIE} from "../src/session.ts";

const ORIGIN="https://gs-poster.test";
const ZONE="Europe/Copenhagen";
const SECRET="browser-acceptance-nonproduction-secret";
const OUT="artifacts/browser-acceptance";
const PNG=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/e5cAAAAASUVORK5CYII=","base64");
const image=n=>"https://raw.githubusercontent.com/GSGrimoire/Images/main/browser-acceptance/"+n+".png";
const assertUnapproved=async(db,id)=>{const p=await getPost(db,id);assert.equal(p?.approved_at,null);assert.ok(["draft","rejected"].includes(p?.status));};
const localDay=(d=new Date())=>{
  const p=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:ZONE,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d).map(x=>[x.type,x.value]));
  return p.year+"-"+p.month+"-"+p.day;
};
const waitFor=async(fn,reason,ms=10000)=>{
  const start=Date.now();
  while(Date.now()-start<ms){if(await fn())return;await new Promise(r=>setTimeout(r,150));}
  throw Error("Timed out: "+reason);
};
await mkdir(OUT,{recursive:true});
const watchdog=setTimeout(()=>{
  console.error("BROWSER_ACCEPTANCE_WATCHDOG: a Chromium action stalled; inspect the last START marker.");
  process.exit(2);
},180000);
watchdog.unref();
const report={commit:process.env.PR90_HEAD_SHA||process.env.GITHUB_SHA||"local",
  environment:"isolated Miniflare + Chromium (not Cloudflare staging)",
  dragEvidence:"Browser DragEvent handler dispatch only; manual physical mouse and touch gesture verification remains mandatory",
  scenarios:[]};
const bundle=await build({entryPoints:["test/fixtures/web-entry.ts"],bundle:true,format:"esm",platform:"neutral",
  target:"es2022",write:false,external:["cloudflare:*","node:*"],
  conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,script:bundle.outputFiles[0].text,
  compatibilityDate:"2026-09-01",compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],
  r2Buckets:["UPLOADS"],
  outboundService:async()=>new Response("External provider calls blocked in browser acceptance",{status:599}),
  bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire",APPROVE_PIN:"not-for-publishing",
    TIMEZONE:ZONE}}));
let browser;
try {
  const db=await mf.getD1Database("DB");
  await ensureSchema(db);
  const photos=[image(0),image(1),image(2)];
  const sibling=[image(3),image(4),image(5)];
  const owned=await createPost(db,{message:"Acceptance example",label:"Browser gallery",images:photos,video:null,
    created_by:"browser-fixture",facebook_enabled:true,tiktok_enabled:true,tiktok_images:sibling,
    scheduled_at:null,bluesky:{caption:"Acceptance #GS",images:[],video:null,patreon:null}});

  const rejected=await createPost(db,{message:"Rejected acceptance",label:"Rejected draft",images:[],video:null,
    created_by:"browser-fixture",facebook_enabled:true,tiktok_enabled:false,scheduled_at:null});
  await db.prepare("UPDATE posts SET status='rejected' WHERE id=?").bind(rejected.id).run();
  const future=new Date(Date.now()+8*24*60*60*1000);
  const timed=await createPost(db,{message:"Safe future draft",label:"Drag me",images:[],video:null,
    created_by:"browser-fixture",facebook_enabled:true,tiktok_enabled:false,scheduled_at:future.toISOString()});

  await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<810)
    INSERT INTO posts (id,created_at,updated_at,status,message,scheduled_at,created_by)
    SELECT 'p_browsermonth_'||n,'2031-04-02T10:00:00.000Z','2031-04-02T10:00:00.000Z',
      'draft','Browser month row','2031-04-15T12:00:00.000Z','browser-fixture' FROM seq`).run();

  browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
  const session=await makeSession({COOKIE_SECRET:SECRET},"GSGrimoire");
  const errors=[];
  const contexts=[];
  async function pageFor(mobile=false){
    const context=await browser.newContext(mobile
      ? {viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true}
      : {viewport:{width:1440,height:900},deviceScaleFactor:1});
    contexts.push(context);
    await context.addCookies([{name:SESSION_COOKIE,value:session,url:ORIGIN,secure:true,httpOnly:true,sameSite:"Lax"}]);
    await context.route("**/*",async route=>{
      const req=route.request(),url=req.url();
      if(!url.startsWith(ORIGIN+"/")){
        await route.fulfill({status:200,contentType:"image/png",body:PNG});
        return;
      }
      try {
        const headers=new Headers(req.headers());
        headers.delete("host"); headers.delete("content-length");
        const data=req.postDataBuffer();
        const res=await mf.dispatchFetch(url,{method:req.method(),headers,
          body:data===null?undefined:data,redirect:"manual"});
        const responseHeaders=Object.fromEntries(res.headers.entries());
        await route.fulfill({status:res.status,headers:responseHeaders,body:Buffer.from(await res.arrayBuffer())});
      }catch(error){
        errors.push("Route "+new URL(url).pathname+": "+String(error));
        await route.fulfill({status:500,contentType:"text/plain",body:"Acceptance fixture dispatch failed"});
      }
    });
    const page=await context.newPage();
    page.setDefaultTimeout(6000);
    page.setDefaultNavigationTimeout(8000);
    page.on("pageerror",e=>errors.push("Browser script: "+e.message));
    return page;
  }
  const desktop=await pageFor(false);
  const mobile=await pageFor(true);
  async function drag(page,source,target,label){
    // Exercise the real app's event handlers in Chromium. Playwright's native
    // mouse / dragTo gestures did not produce dragstart on nested gallery
    // controls in headless CI and could hang. This test is NOT evidence that
    // physical mouse or touch dragging works: staging manual tests are still
    // required for that separate release gate.
    const from=await source.elementHandle(),to=await target.elementHandle();
    assert.ok(from&&to,"missing drag elements: "+label);
    const events=await page.evaluate(([src,dst])=>{
      const dataTransfer=new DataTransfer();
      const logged=[];
      for(const type of ["dragstart","dragover","drop","dragend"])
        document.addEventListener(type,e=>logged.push(type+":"+e.target.tagName),{capture:true});
      const fire=(node,type)=>node.dispatchEvent(new DragEvent(type,{
        bubbles:true,cancelable:true,dataTransfer}));
      fire(src,"dragstart");
      fire(dst,"dragover");
      fire(dst,"drop");
      fire(src,"dragend");
      return logged;
    },[from,to]);
    console.log("BROWSER_DRAG_EVENT_HANDLERS",label,events.join(","));
    assert.ok(events.some(x=>x.startsWith("dragstart")),"missing dragstart handler invocation: "+label);
    assert.ok(events.some(x=>x.startsWith("drop")),"missing drop handler invocation: "+label);
  }
  async function scenario(name,page,fn){
    console.log("START",name);
    const clean=name.replace(/[^a-z0-9-]+/gi,"-").toLowerCase();
    const item={name,status:"pass"};
    try {await fn();}catch(e){item.status="fail";item.error=String(e.stack||e);console.error("FAIL",name,item.error);}
    finally {
      try{await page.screenshot({path:OUT+"/"+clean+".png",fullPage:false});}catch(e){item.screenshotError=String(e);}
      report.scenarios.push(item);console.log(item.status.toUpperCase(),name);
    }
  }

  await scenario("desktop-bluesky-click-one-shot-autosave",desktop,async()=>{
    await desktop.goto(ORIGIN+"/post/"+owned.id);
    const picker=desktop.locator(".bs-copy-picker");
    if(!(await picker.evaluate(e=>e.open)))await picker.locator("summary").click();
    await desktop.locator('[data-copy-bs="0"]').click();
    await desktop.locator('[name="bs_add_alt_0"]').fill("First browser image");
    // Staging alone must never start autosave without an explicit copy click.
    await desktop.waitForTimeout(1200);
    assert.equal((await getPost(db,owned.id)).bluesky?.images.length,0);
    await desktop.locator("#bs-copy-save").click();
    await waitFor(async()=>((await getPost(db,owned.id))?.bluesky?.images.length===1),"one-shot Bluesky copy");
    const p=await getPost(db,owned.id);
    assert.deepEqual(p.bluesky.images,[{url:photos[0],alt:"First browser image"}]);
    assert.deepEqual(p.images,photos);
    await assertUnapproved(db,owned.id);
  });
  await scenario("desktop-bluesky-source-drag",desktop,async()=>{
    await desktop.goto(ORIGIN+"/post/"+owned.id);
    const picker=desktop.locator(".bs-copy-picker");
    if(!(await picker.evaluate(e=>e.open)))await picker.locator("summary").click();
    await drag(desktop,desktop.locator('.bs-source-item[data-pool-index="1"]'),desktop.locator("#bs-copy-drop"),"Bluesky source copy");
    assert.equal(await desktop.locator('[name="bs_add_alt_1"]').count(),1);
    await desktop.locator('[name="bs_add_alt_1"]').fill("Second browser image");
    await desktop.locator("#bs-copy-save").click();
    await waitFor(async()=>((await getPost(db,owned.id))?.bluesky?.images.length===2),"drag Bluesky copy");
    assert.deepEqual((await getPost(db,owned.id)).bluesky.images.map(x=>x.alt),
      ["First browser image","Second browser image"]);
    await assertUnapproved(db,owned.id);
  });
  await scenario("desktop-facebook-tiktok-bluesky-photo-order",desktop,async()=>{
    await desktop.goto(ORIGIN+"/post/"+owned.id);
    for(const target of ["facebook","tiktok","bluesky"]){
      const region=desktop.locator('.tiles[data-media="'+target+'"]');
      const moves=region.locator('[data-move="1"]:not([disabled])');
      assert.ok(await moves.count()>0,target+" must expose a move control");
      await moves.first().click();
    }
    const fb=await desktop.locator('input[name="order_fb"]').inputValue();
    const tt=await desktop.locator('input[name="order_tt"]').inputValue();
    const bs=await desktop.locator('input[name="order_bs"]').inputValue();
    assert.notEqual(fb,"0,1,2");assert.notEqual(tt,"0,1,2");assert.notEqual(bs,"0,1");
    const original=(await getPost(db,owned.id)).images;
    await waitFor(async()=>((await getPost(db,owned.id))?.images[0]!==original[0]),"reordered autosave");
    await assertUnapproved(db,owned.id);
  });
  await scenario("desktop-photo-drag-order",desktop,async()=>{
    await desktop.goto(ORIGIN+"/post/"+owned.id);
    const tiles=desktop.locator('.tiles[data-media="facebook"] > [data-index]');
    const before=await tiles.evaluateAll(ns=>ns.map(n=>n.querySelector("img")?.src));
    await drag(desktop,tiles.first(),tiles.last(),"Facebook card reorder");
    const after=await tiles.evaluateAll(ns=>ns.map(n=>n.querySelector("img")?.src));
    assert.notDeepEqual(after,before,"drag must visibly change DOM order");
    await assertUnapproved(db,owned.id);
  });
  await scenario("desktop-rejected-return-without-approval",desktop,async()=>{
    await desktop.goto(ORIGIN+"/post/"+rejected.id);
    await desktop.locator('form[action$="/return-to-drafts"] button[type="submit"]').click();
    await waitFor(async()=>((await getPost(db,rejected.id))?.status==="draft"),"rejected return");
    await assertUnapproved(db,rejected.id);
  });
  await scenario("desktop-week-now-line-and-drag-modal",desktop,async()=>{
    await desktop.goto(ORIGIN+"/calendar?view=week&week="+localDay());
    assert.equal(await desktop.locator(".calendar-now:not([hidden])").count(),1);
    const top=await desktop.locator(".calendar-now:not([hidden])").evaluate(e=>e.style.top);
    assert.match(top,/px$/);
    assert.equal(await desktop.locator(".calendar-now:not([hidden])").evaluate(e=>getComputedStyle(e).pointerEvents),"none");
    await desktop.goto(ORIGIN+"/calendar?view=week&week="+localDay(future));
    const card=desktop.locator('.calendar-post[draggable="true"][data-id="'+timed.id+'"]');
    assert.equal(await card.count(),1,"future draft must be draggable");
    const pos=await card.evaluate(e=>({day:e.closest(".calendar-day").dataset.day,
      halfHour:Math.floor(parseFloat(e.style.top)/30)}));
    const slot=desktop.locator('.calendar-day[data-day="'+pos.day+'"] .calendar-slot')
      .nth(pos.halfHour<47?pos.halfHour+1:pos.halfHour-1);
    assert.equal(await slot.getAttribute("aria-disabled"),null);
    await drag(desktop,card,slot,"Week future draft reschedule");
    assert.equal(await desktop.locator("#cal-dialog[open]").count(),1,"drag must show a review dialog, not publish");
    await assertUnapproved(db,timed.id);
  });
  await scenario("desktop-month-pagination-and-day-navigation",desktop,async()=>{
    await desktop.goto(ORIGIN+"/calendar?view=month&month=2031-04");
    assert.equal(await desktop.locator(".calendar-month-post").count(),750);
    assert.equal(await desktop.locator('a[href*="month_page=2"]').count(),1);
    await desktop.locator('a[href*="month_page=2"]').click();
    assert.equal(await desktop.locator(".calendar-month-post").count(),60);
    assert.ok((await desktop.locator(".calendar-month-post").first().textContent()).includes("Browser"));
    await desktop.locator('.calendar-month-day[data-day="2031-04-15"] .calendar-month-date').click();
    assert.ok(desktop.url().includes("view=week"));
    assert.ok(desktop.url().includes("2031-04-15"));
    await assertUnapproved(db,owned.id);
  });
  await scenario("desktop-daylight-saving-month-navigation",desktop,async()=>{
    await desktop.goto(ORIGIN+"/calendar?view=month&month=2026-10");
    await desktop.locator('.calendar-month-day[data-day="2026-10-25"] .calendar-month-date').click();
    assert.ok(desktop.url().includes("2026-10-25"));
    assert.ok((await desktop.locator(".calendar-window").count())===1);
  });
  await scenario("desktop-new-draft-photo-drag-keeps-targets-and-alt",desktop,async()=>{
    await desktop.goto(ORIGIN+"/new");
    for(const target of ["facebook","bluesky","tiktok"])await desktop.locator('input[name="'+target+'"]').check();
    await desktop.locator('input[name="content_kind"][value="images"]').check();
    await desktop.locator("#new-images-input").setInputFiles(["one","two","three"].map(name=>({
      name:name+".png",mimeType:"image/png",buffer:PNG
    })));
    const tiles=desktop.locator("#new-images-preview .new-file");
    assert.equal(await tiles.count(),3);
    await tiles.nth(0).locator('input[placeholder="Describe what is visible"]').fill("Alt for first");
    await tiles.nth(0).getByRole("checkbox",{name:"TikTok for one.png"}).uncheck();
    await drag(desktop,tiles.nth(0),tiles.nth(2),"New draft image reorder");
    const first=desktop.locator('#new-images-preview .new-file').filter({hasText:"one.png"});
    assert.equal(await first.locator('input[placeholder="Describe what is visible"]').inputValue(),"Alt for first");
    assert.equal(await first.getByRole("checkbox",{name:"TikTok for one.png"}).isChecked(),false);
    assert.equal(await desktop.locator("#new-images-preview .new-file").last().innerText().then(s=>s.includes("one.png")),true);
    // No submit: new draft drag may never trigger a publishing action.
  });
  await scenario("mobile-month-horizontal-scroll-and-pagination",mobile,async()=>{
    await mobile.goto(ORIGIN+"/calendar?view=month&month=2031-04");
    const wrap=mobile.locator(".calendar-month-wrap");
    const size=await wrap.evaluate(e=>({scroll:e.scrollWidth,client:e.clientWidth}));
    assert.ok(size.scroll>size.client,"mobile must expose horizontally scrollable month");
    await wrap.evaluate(e=>{e.scrollLeft=150;});
    assert.ok(await wrap.evaluate(e=>e.scrollLeft)>0);
    assert.equal(await mobile.locator(".calendar-month-post").count(),750);
    await mobile.locator('a[href*="month_page=2"]').click();
    assert.equal(await mobile.locator(".calendar-month-post").count(),60);
  });
  await scenario("mobile-editor-keyboard-reorder",mobile,async()=>{
    await mobile.goto(ORIGIN+"/post/"+owned.id);
    const box=mobile.locator('.tiles[data-media="facebook"]');
    const before=await box.locator(":scope > [data-index]").evaluateAll(ns=>ns.map(n=>n.querySelector("img")?.src));
    const move=box.locator('[data-move="1"]:not([disabled])').first();
    await move.focus();
    await mobile.keyboard.press("Enter");
    const after=await box.locator(":scope > [data-index]").evaluateAll(ns=>ns.map(n=>n.querySelector("img")?.src));
    assert.notDeepEqual(before,after);
    await assertUnapproved(db,owned.id);
  });
  await scenario("mobile-week-now-line",mobile,async()=>{
    await mobile.goto(ORIGIN+"/calendar?view=week&week="+localDay());
    assert.equal(await mobile.locator(".calendar-now:not([hidden])").count(),1);
    assert.equal(await mobile.locator(".calendar-now:not([hidden])").evaluate(e=>getComputedStyle(e).pointerEvents),"none");
  });
  for(const context of contexts)await context.close();
  if(errors.length)report.errors=errors;
  report.total=report.scenarios.length;
  report.failed=report.scenarios.filter(x=>x.status==="fail").length+errors.length;
  await writeFile(OUT+"/results.json",JSON.stringify(report,null,2)+"\n");
  console.log("BROWSER_ACCEPTANCE_RESULTS",JSON.stringify({passed:report.total-report.scenarios.filter(x=>x.status==="fail").length,failed:report.failed,errors:errors.length}));
  if(report.failed)process.exitCode=1;
  clearTimeout(watchdog);
} finally {
  if(browser)await browser.close();
  await mf.dispose();
}
