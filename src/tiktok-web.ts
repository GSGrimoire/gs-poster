/** TikTok editor settings and Login Kit callback.
 * No automatic content publishing or token exposure in HTML.
 */
import type {Env} from "./env.ts";
import {audit} from "./db.ts";
import {esc,html,page} from "./html.ts";
import {checkCsrf,csrfToken,readSession,type Session} from "./session.ts";
import {isSameOrigin} from "./origin.ts";
import {
  beginTikTokConnection,clearTikTokStateCookie,disconnectTikTok,
  finishTikTokConnection,
  TIKTOK_SCOPES,tiktokConfigured,tiktokConnection,tiktokRedirect,tiktokStateCookie,
} from "./tiktok.ts";
import {tiktokCallbackPlaceholder} from "./public-pages.ts";
import {saveTikTokVerificationFile,TIKTOK_MEDIA_PREFIX} from "./tiktok-media.ts";

const redirect=(location:string,cookieValue?:string):Response=>{
  const h=new Headers({Location:location,"Cache-Control":"no-store","Referrer-Policy":"no-referrer"});
  if(cookieValue)h.append("Set-Cookie",cookieValue);
  return new Response(null,{status:303,headers:h});
};
/** A top-level navigation is not subject to the preceding form's form-action redirect chain. */
export const TIKTOK_CONNECT_JS = String.raw`
(() => {
  const link = document.getElementById("tiktok-continue-link");
  if (!link) return;
  try {
    const target = new URL(link.href);
    if (target.protocol !== "https:" ||
        target.hostname !== "www.tiktok.com" ||
        target.pathname !== "/v2/auth/authorize/") return;
    window.location.replace(target.href);
  } catch {
    // The page leaves an explicit link so the editor can continue manually.
  }
})();
`;

const fail=(message:string,status=400,login?:string)=>
  html(page("TikTok connection",`<h2>TikTok connection</h2>
    <div class="notice err" role="alert">${esc(message)}</div>
    <p><a href="/tiktok/settings">Back to TikTok settings</a></p>`
    .replace("${esc(message)}",esc(message)),{login}),{status});
export async function tiktokCallback(req:Request,env:Env):Promise<Response> {
  if(req.method!=="GET")return new Response("Method not allowed",{status:405,headers:{Allow:"GET"}});
  const u=new URL(req.url);
  if(!u.searchParams.has("state")&&!u.searchParams.has("code")&&!u.searchParams.has("error"))
    return tiktokCallbackPlaceholder(req);
  const session=await readSession(env,req);
  if(!session)return fail("Your GitHub session expired. Start connecting TikTok again.",401);
  try {
    const result=await finishTikTokConnection(env,session,req);
    await audit(env.DB,session.login,"tiktok-account-connected",null,
      "granted scopes: "+result.scopes).catch(()=>undefined);
    return redirect("/tiktok/settings?notice=connected",clearTikTokStateCookie());
  }catch(error) {
    // Never reveal TikTok codes, tokens or query arguments on the error page.
    const message=error instanceof Error ? error.message : "TikTok authorization failed.";
    const resp=fail(message,400,session.login);
    resp.headers.append("Set-Cookie",clearTikTokStateCookie());
    return resp;
  }
}
export async function tiktokSettings(env:Env,session:Session,notice=""):Promise<Response> {
  const conn=await tiktokConnection(env.DB);
  const enabled=tiktokConfigured(env);
  const csrf=await csrfToken(env,session);
  const granted=conn?.scopes.split(",").filter(Boolean)||[];
  const readiness=`<div class="step-card">
      <div class="eyebrow">Connection readiness</div>
      <div class="summary-row"><span><span class="status-led ${enabled?"":"err"}"></span>Worker credentials</span><strong>${enabled?"Configured":"Action needed"}</strong></div>
      <div class="summary-row"><span><span class="status-led ${conn?"":"warn"}"></span>TikTok account</span><strong>${conn?"Connected":"Not connected"}</strong></div>
      <div class="summary-row"><span><span class="status-led warn"></span>Media URL ownership</span><strong>Confirm in TikTok</strong></div>
      <p class="rail-note">The last step is verified in TikTok's developer portal. GS Poster cannot check it automatically.</p>
    </div>`;
  const body=`<div class="hero">
    <div class="hero-kicker">GS Grimoire · Social connections</div>
    <h2>Connect once. Create freely.</h2>
    <p>Control which TikTok account receives your videos and carousels. Connecting grants permissions only; publishing still requires your explicit approval PIN.</p>
    </div>
    ${readiness}
  ${notice==="connected"?'<div class="notice ok">TikTok account connected. Choose a posting method on a draft when you are ready.</div>':""}
  ${notice==="disconnected"?'<div class="notice">Local TikTok connection removed.</div>':""}
  ${notice==="revoke-warning"?'<div class="notice err">Local credentials were removed, but TikTok did not confirm revocation. Revoke GS Poster in TikTok account settings if necessary.</div>':""}
  ${!enabled?'<div class="notice err">TikTok is not configured yet. Add TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_TOKEN_ENCRYPTION_KEY as Cloudflare Worker secrets before connecting.</div>':""}
  <div class="step-card"><div class="step-heading"><span class="step-number">1</span><div>
    <h3>App authorization</h3><p class="hint">Only the requested permissions appear on TikTok's consent screen.</p></div></div>
    <p class="form-info">Login Kit redirect address</p><code style="display:block;overflow-wrap:anywhere">${esc(tiktokRedirect(env))}</code>
    <p class="form-info"><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/about">Public About page</a></p>
  </div>
  <div class="step-card">
    <div class="step-heading"><span class="step-number">2</span><div><h3>Verify your media address</h3>
      <p class="hint">Required for image carousels and link-based video posting.</p></div></div>
    <p class="form-info">In GS TT Poster, open TikTok Developer Portal → URL properties, then verify this exact prefix:</p>
    <code style="display:block;overflow-wrap:anywhere">${esc(TIKTOK_MEDIA_PREFIX)}</code>
    <p class="choice-advice">TikTok supplies a text verification file. Paste the filename and exact contents below, host it, then finish the verification in TikTok. This does not expose your private draft artwork.</p>
    <form method="post" action="/tiktok/verify">
      <input name="csrf" type="hidden" value="${esc(csrf)}">
      <label for="tt-verify-filename">Verification filename from TikTok</label>
      <input type="text" name="filename" id="tt-verify-filename" placeholder="tiktok_...txt" required>
      <label for="tt-verify-content">Contents of TikTok verification file</label>
      <textarea name="contents" id="tt-verify-content" maxlength="8192" style="min-height:100px" required></textarea>
      <button type="submit">Host verification file</button>
    </form>
    <p class="hint">Once hosted, complete ownership verification in TikTok. This is required for photo carousels and URL-based video publishing.</p>
  </div>
  ${conn?
    `<div class="step-card">
      <div class="step-heading"><span class="step-number">3</span><div><h3>Connected TikTok account</h3>
        <p class="hint">Your account is available for separately approved transfers.</p></div></div>
      <p><strong>Connection:</strong> Active</p>
      <p><strong>Account identifier:</strong> ${esc(conn.open_id)}</p>
      <p><strong>Granted permissions:</strong> ${esc(granted.join(", "))}</p>
      <p><strong>Connected by:</strong> ${esc(conn.connected_by)}</p>
      <p class="hint">This page never shows access or refresh tokens. TikTok uploads require a separate editor action. Manual inbox publication happens in TikTok. Direct Post requires separate user confirmation.</p>
      <form method="post" action="/tiktok/disconnect">
        <input name="csrf" type="hidden" value="${esc(csrf)}">
        <label><input type="checkbox" name="confirm" value="yes" required> Disconnect this TikTok account and revoke its access</label>
        <button type="submit">Disconnect TikTok</button>
      </form>
    </div>` :
    `<form method="post" action="/tiktok/connect" class="step-card">
      <div class="step-heading"><span class="step-number">3</span><div><h3>Connect a TikTok account</h3>
        <p class="hint">You remain signed in to GS Poster through GitHub.</p></div></div>
      <p>The TikTok consent screen will show the exact permissions requested. Only select permissions enabled in your TikTok developer application.</p>
      <input name="csrf" type="hidden" value="${esc(csrf)}">
      <p><label><input type="checkbox" checked disabled> Read basic account profile (required)</label></p>
      <p><label><input type="checkbox" name="video.upload" value="1" checked> Upload videos and photo carousels to your TikTok inbox for manual publication</label></p>
      <p><label><input type="checkbox" name="video.publish" value="1"> Request direct publishing access (private testing; separate explicit consent required)</label></p>
      <button class="primary" type="submit" ${enabled?"":"disabled"}>Connect TikTok</button>
      <p class="hint">Connecting only grants access. No content is posted until a separate explicit publishing action is implemented and approved.</p>
    </form>`}
  <div class="step-card"><div class="eyebrow">Next step</div>
    <h3 style="margin:8px 0">Create your next post</h3>
    <p class="hint">Try a two-image carousel first. Sending to the TikTok inbox is safer for initial testing than immediate Direct Post.</p>
    <p class="inline-actions"><a class="btn" href="/new">+ Create a draft</a><a class="btn" href="/">Open planner</a></p>
    <p class="rail-note">Automatic TikTok scheduling is not enabled. Every TikTok transfer is a separate approval action, independent of your planner time.</p>
  </div>`;
  // Templates contain only escaped account fields or fixed server-defined strings.
  return html(page("TikTok settings",body,{login:session.login}));
}
export async function tiktokSettingsAction(
  req:Request,env:Env,session:Session,action:string,
):Promise<Response> {
  if(req.method!=="POST")return new Response("Method not allowed",{status:405,headers:{Allow:"POST"}});
  if(!isSameOrigin(new URL(req.url).origin,req.headers.get("Origin"),req.headers.get("Sec-Fetch-Site")))
    return fail("Cross-site request refused.",403,session.login);
  if(Number(req.headers.get("content-length")||0)>8192)
    return fail("Request too large.",413,session.login);
  const form=await req.formData().catch(()=>null);
  if(!form||!await checkCsrf(env,session,String(form.get("csrf")||"")))
    return fail("Form expired. Reload and try again.",403,session.login);
  try {
    if(action==="connect") {
      if(await tiktokConnection(env.DB))throw new Error("Disconnect the current TikTok account before reconnecting.");
      const requested=TIKTOK_SCOPES.filter(s=>s==="user.info.basic"||form.get(s)==="1");
      const link=await beginTikTokConnection(env,session,requested);
      // Do NOT return an external 303 from a form POST. Some browsers enforce
      // form-action 'self' on the entire redirect chain and silently block TikTok.
      // Serve a same-origin document with a safe client-side navigation and
      // a visible fallback link instead, preserving the strict CSP.
      const connectionPage=page("Continue to TikTok",
        `<h2>Connect TikTok</h2>
        <p>Opening TikTok to authorize GS Poster. If nothing happens, select the link below.</p>
        <p><a id="tiktok-continue-link" class="btn" rel="noreferrer"
            href="${esc(link.url)}">Continue to TikTok</a></p>
        <p class="hint">Only authorize the permissions displayed by TikTok.</p>
        <script src="/tiktok-connect.js" defer></script>`,
        {login:session.login});
      const response=html(connectionPage);
      response.headers.set("Set-Cookie",tiktokStateCookie(link.state));
      // Override the existing defaults instead of appending incompatible
      // duplicate Cache-Control or Referrer-Policy directives.
      response.headers.set("Cache-Control","no-store");
      response.headers.set("Referrer-Policy","no-referrer");
      return response;
    }
    if(action==="verify") {
      const filename=String(form.get("filename")||"");
      const contents=String(form.get("contents")||"");
      await saveTikTokVerificationFile(env.DB,filename,contents);
      await audit(env.DB,session.login,"tiktok-verification-hosted",null,
        "Public URL prefix verification file hosted").catch(()=>undefined);
      return html(page("TikTok verification file hosted",
        `<h2>Verification file hosted</h2>
          <p>Open the public file and complete verification in your TikTok developer portal:</p>
          <p><a href="${esc(TIKTOK_MEDIA_PREFIX+filename)}">${esc(TIKTOK_MEDIA_PREFIX+filename)}</a></p>
          <p><a href="/tiktok/settings">Back to TikTok settings</a></p>`,
        {login:session.login}));
    }
    if(action==="disconnect") {
      if(form.get("confirm")!=="yes")throw new Error("Please confirm disconnection.");
      const result=await disconnectTikTok(env);
      await audit(env.DB,session.login,"tiktok-account-disconnected",null,
        result.revoked?"remote authorization revoked":"remote revocation unconfirmed").catch(()=>undefined);
      return redirect(result.revoked?"/tiktok/settings?notice=disconnected":"/tiktok/settings?notice=revoke-warning");
    }
    return new Response("Not found",{status:404});
  }catch(error) {
    return fail(error instanceof Error?error.message:"TikTok request failed.",400,session.login);
  }
}
