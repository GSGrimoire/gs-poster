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
  const body=`<p><a href="/">← Back to GS Poster</a></p>
  <h2>TikTok connection</h2>
  <p>TikTok authorizes the publishing account separately from the GitHub editor login. Nothing is sent to TikTok when you create a GS Poster draft.</p>
  ${notice==="connected"?'<div class="notice ok">TikTok account connected. Publishing remains disabled pending validation.</div>':""}
  ${notice==="disconnected"?'<div class="notice">Local TikTok connection removed.</div>':""}
  ${notice==="revoke-warning"?'<div class="notice err">Local credentials were removed, but TikTok did not confirm revocation. Revoke GS Poster in TikTok account settings if necessary.</div>':""}
  ${!enabled?'<div class="notice err">TikTok is not configured yet. Add TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_TOKEN_ENCRYPTION_KEY as Cloudflare Worker secrets before connecting.</div>':""}
  <div class="card"><h3>Developer portal settings</h3>
    <p>Login Kit redirect URI:</p><code>${esc(tiktokRedirect(env))}</code>
    <p><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/about">Public About page</a></p>
  </div>
  ${conn?
    `<div class="card">
      <h3>Connected TikTok account</h3>
      <p><strong>Connection:</strong> Active</p>
      <p><strong>Account identifier:</strong> ${esc(conn.open_id)}</p>
      <p><strong>Granted permissions:</strong> ${esc(granted.join(", "))}</p>
      <p><strong>Connected by:</strong> ${esc(conn.connected_by)}</p>
      <p class="hint">This page never shows access or refresh tokens. TikTok uploads require a separate editor action. Manual publication happens in TikTok.</p>
      <form method="post" action="/tiktok/disconnect">
        <input name="csrf" type="hidden" value="${esc(csrf)}">
        <label><input type="checkbox" name="confirm" value="yes" required> Disconnect this TikTok account and revoke its access</label>
        <button type="submit">Disconnect TikTok</button>
      </form>
    </div>` :
    `<form method="post" action="/tiktok/connect" class="card">
      <h3>Connect a TikTok account</h3>
      <p>The TikTok consent screen will show the exact permissions requested. Only select permissions enabled in your TikTok developer application.</p>
      <input name="csrf" type="hidden" value="${esc(csrf)}">
      <p><label><input type="checkbox" checked disabled> Read basic account profile (required)</label></p>
      <p><label><input type="checkbox" name="video.upload" value="1" checked> Upload videos to your TikTok inbox for manual publication</label></p>
      <button class="primary" type="submit" ${enabled?"":"disabled"}>Connect TikTok</button>
      <p class="hint">Connecting only grants access. No content is posted until a separate explicit publishing action is implemented and approved.</p>
    </form>`}
  <p class="hint">The first integration sends videos to your TikTok inbox. You must complete publication in TikTok. Direct scheduled publishing is not yet implemented.</p>`;
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
