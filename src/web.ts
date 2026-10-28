/**
 * The human side: GitHub sign-in, the OAuth consent page for connecting
 * Claude, and the approval page where Gus approves, edits, rejects or cancels.
 */
import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { allowedLogins, missingSecrets, type Env } from "./env.ts";
import { audit, attachDraftImage, attachDraftVideo, createPost, getPost, listPosts, listCalendarPosts, pinLocked, recentAudit, recordPinFailure, type BlueskyDraft, type Post } from "./db.ts";
import { checkBluesky } from "./bluesky.ts";
import { esc, html, page } from "./html.ts";
import { CALENDAR_JS, renderCalendar, weekStart, weekRange } from "./calendar.ts";
import { blankNewDraft, newDraftPrefill, parseNewDraft, renderNewDraft, soonestDraftTime, type NewDraftFields } from "./new-draft.ts";
import { NEW_DRAFT_JS } from "./new-draft-client.ts";
import { publicPage } from "./public-pages.ts";
import { TIKTOK_CONNECT_JS, tiktokCallback, tiktokSettings, tiktokSettingsAction } from "./tiktok-web.ts";
import { tiktokConnection } from "./tiktok.ts";
import { getTikTokInboxTransfer, startTikTokInboxTransfer, refreshTikTokInboxTransfer } from "./tiktok-inbox.ts";
import { DRAFT_MEDIA_JS, draftMediaPanel } from "./draft-media.ts";
import { createUpload, isStoredOwnerUpload, isStoredOwnerVideo } from "./upload.ts";
import { fetchImage } from "./media.ts";
import { fetchVideo } from "./video.ts";
import {
  getFacebookUploadProgress, resumeFailedFacebookUploads, abandonFacebookUpload,
  markFacebookUploadPosted, BULK_FACEBOOK_THRESHOLD, BULK_SCHEDULE_MIN_LEAD_MS,
} from "./facebook-queue.ts";
import { approveAndPublish, backToDraft, cancelScheduled, refreshScheduled, rejectPost, retryFailedBluesky, retryFailedFacebook, reschedulePost, editPendingCaptions, restoreCancelledPost } from "./publish.ts";
import {
  checkCsrf,
  cookie,
  csrfToken,
  getCookie,
  LOGIN_STATE_COOKIE,
  makeSession,
  randomToken,
  readSession,
  safeEqual,
  SESSION_COOKIE,
  sessionCookie,
  sha256,
  type Session,
} from "./session.ts";
import { isSameOrigin } from "./origin.ts";
import { formatLocal, localToUtc, toLocalInput } from "./time.ts";
import { APPROVE_MIN_LEAD_MS, checkMessage, checkWhen } from "./validate.ts";

const redirect = (location: string, headers?: Headers): Response => {
  const h = headers ?? new Headers();
  h.set("Location", location);
  h.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: h });
};

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function sameOrigin(req: Request): boolean {
  return isSameOrigin(new URL(req.url).origin, req.headers.get("Origin"), req.headers.get("Sec-Fetch-Site"));
}

async function requireSession(env: Env, req: Request): Promise<Session | Response> {
  const s = await readSession(env, req);
  if (s) return s;
  const u = new URL(req.url);
  return redirect(`/login?next=${encodeURIComponent(u.pathname + u.search)}`);
}

export async function handleWeb(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/health") return Response.json({ok:true});
  // Public legal/app-review URLs are deliberately outside the GitHub login wall.
  if (path === "/about" || path === "/terms" || path === "/privacy") {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed",{status:405,headers:{"Allow":"GET, HEAD"}});
    const response = publicPage(path.slice(1) as "about" | "terms" | "privacy");
    return req.method === "HEAD" ? new Response(null,{status:response.status,headers:response.headers}) : response;
  }
  if (path === "/tiktok/callback") return tiktokCallback(req,env);
  if (path === "/robots.txt") return new Response(
    "User-agent: *\nAllow: /about\nAllow: /terms\nAllow: /privacy\nDisallow: /\n",
    {headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"public, max-age=3600"}});

  if (path === "/login") return login(req, env);
  if (path === "/callback") return callback(req, env);
  if (path === "/logout") {
    const h = new Headers();
    h.append("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
    return redirect("/", h);
  }
  if (path === "/authorize") return authorize(req, env);

  const auth = await requireSession(env, req);
  if (auth instanceof Response) return auth;
  const session = auth;
  if (path === "/tiktok-connect.js" && req.method === "GET")
    return new Response(TIKTOK_CONNECT_JS,{headers:{
      "Content-Type":"application/javascript; charset=utf-8",
      "Cache-Control":"no-store","X-Content-Type-Options":"nosniff"
    }});
  if (path === "/tiktok/settings" && req.method === "GET") return tiktokSettings(env,session,url.searchParams.get("notice")||"");
  if (/^\/tiktok\/(connect|disconnect)$/.test(path) && req.method === "POST")
    return tiktokSettingsAction(req,env,session,path.split("/").pop()!);

  if (path === "/new-draft.js" && req.method === "GET") return new Response(NEW_DRAFT_JS, {headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  if (path === "/draft-media.js" && req.method === "GET") return new Response(DRAFT_MEDIA_JS, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  const uploadAction = /^\/post\/(p_[a-z0-9]+)\/(upload-link|attach-image|video-link|attach-video)$/.exec(path);
  if (uploadAction && req.method === "POST") return draftImageAction(req, env, session, uploadAction[1], uploadAction[2]);
  if (path === "/calendar.js" && req.method === "GET") return new Response(CALENDAR_JS, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  if ((path === "/" || path === "/calendar") && req.method === "GET") return dashboard(env, session, url.searchParams.get("week"));
  if (path === "/new" && (req.method === "GET" || req.method === "POST")) return newDraftPage(req,env,session);

  const m = /^\/post\/(p_[a-z0-9]+)(?:\/(approve|reject|cancel|redraft|retry-bluesky|retry-facebook|resume-facebook|abandon-facebook|reconcile-facebook|reschedule|edit-caption|restore-cancelled|tiktok-upload|tiktok-status))?$/.exec(path);
  if (m) {
    const [, id, action] = m;
    if (!action && req.method === "GET") return postPage(env, session, id, {});
    if (action && req.method === "POST") return postAction(req, env, session, id, action);
  }
  const video = /^\/video\/(p_[a-z0-9]+)\/(facebook|bluesky)$/.exec(path);
  if (video && req.method === "GET") return videoProxy(req,env,video[1],video[2]);
  const media = /^\/media\/(p_[a-z0-9]+)\/(\d+)$/.exec(path);
  if (media && req.method === "GET") return mediaProxy(env, media[1], Number(media[2]), url.searchParams.get("thumb") === "1");

  return html(page("Not found", `<p class="empty">Nothing here.</p>`, { login: session.login }), { status: 404 });
}

// ---------------------------------------------------------------- sign-in

async function login(req: Request, env: Env): Promise<Response> {
  const missing = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "COOKIE_SECRET"].filter((k) => !env[k as keyof Env]);
  if (missing.length) {
    return html(page("Setup needed", `<div class="notice err">Sign-in is not set up yet. Missing secrets: ${missing.map(esc).join(", ")}.</div>`), { status: 503 });
  }
  const url = new URL(req.url);
  const state = randomToken();
  await env.OAUTH_KV.put(`gsp-login:${await sha256(state)}`, JSON.stringify({ next: safeNext(url.searchParams.get("next")) }), { expirationTtl: 600 });
  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
  gh.searchParams.set("redirect_uri", `${url.origin}/callback`);
  gh.searchParams.set("state", state);
  gh.searchParams.set("allow_signup", "false");
  const h = new Headers();
  h.append("Set-Cookie", cookie(LOGIN_STATE_COOKIE, state, 600));
  return redirect(gh.toString(), h);
}

async function callback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const bound = getCookie(req, LOGIN_STATE_COOKIE) || "";
  const fail = (msg: string, status = 400) => html(page("Sign-in failed", `<div class="notice err">${esc(msg)}</div><p><a href="/login">Try again</a></p>`), { status });

  if (url.searchParams.get("error")) return fail("GitHub sign-in was cancelled.");
  if (!state || !bound || !safeEqual(state, bound)) return fail("This sign-in link expired or was opened in another browser.");
  const key = `gsp-login:${await sha256(state)}`;
  const saved = await env.OAUTH_KV.get<{ next: string }>(key, "json");
  await env.OAUTH_KV.delete(key);
  if (!saved || !code) return fail("This sign-in link expired. Start again.");

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "gs-poster" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/callback`,
    }),
  });
  const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tok.access_token) return fail("GitHub did not accept the sign-in. Check the OAuth app's callback URL.");
  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tok.access_token}`, "User-Agent": "gs-poster", Accept: "application/vnd.github+json" },
  });
  const user = (await userRes.json().catch(() => ({}))) as { login?: string };
  // We only needed the identity. Drop GitHub's token now.
  await fetch(`https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`, {
    method: "DELETE",
    headers: {
      Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
      "User-Agent": "gs-poster",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ access_token: tok.access_token }),
  }).catch(() => undefined);

  if (!user.login) return fail("Could not read your GitHub account.");
  if (!allowedLogins(env).includes(user.login.toLowerCase())) {
    return fail(`The GitHub account "${user.login}" is not allowed to use this server.`, 403);
  }
  const h = new Headers();
  h.append("Set-Cookie", sessionCookie(await makeSession(env, user.login)));
  h.append("Set-Cookie", cookie(LOGIN_STATE_COOKIE, "", 0));
  return redirect(saved.next, h);
}

// ---------------------------------------------------------------- connecting Claude (OAuth consent)

async function authorize(req: Request, env: Env): Promise<Response> {
  const session = await readSession(env, req);
  if (!session) {
    const u = new URL(req.url);
    if (req.method !== "GET") return html(page("Signed out", `<div class="notice err">Your session ended. Start connecting again.</div>`), { status: 401 });
    return redirect(`/login?next=${encodeURIComponent(u.pathname + u.search)}`);
  }
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (req.method === "GET") {
      const areq = await oauth.parseAuthRequest(req);
      const details = await oauth.describeConsent(areq);
      const consent = await oauth.beginConsent(areq);
      const origin = details.clientDomain
        ? `Published by <strong>${esc(details.clientDomain)}</strong>.`
        : "This app registered itself, so its name is not verified.";
      const loop = details.redirectIsLoopback
        ? `<div class="notice err">This sends access to an app on your own computer. Continue only if you just started connecting from it.</div>`
        : "";
      const body = `
        <h2>Connect an app</h2>
        <div class="card">
          <p><strong>${esc(details.clientName)}</strong> wants to use GS Poster as ${esc(session.login)}.</p>
          <p class="hint">${origin} Access goes to <strong>${esc(details.redirectHost)}</strong>.</p>
          <p class="hint">It will be able to draft, edit and list posts, and read your Page's recent posts. It cannot publish: only you can, from this site, with your PIN.</p>
          ${loop}
          <form method="post">
            <input type="hidden" name="handle" value="${esc(consent.handle)}">
            ${details.scope.map((s) => `<input type="hidden" name="scope" value="${esc(s)}">`).join("")}
            <div class="row"><button class="primary" name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></div>
          </form>
        </div>`;
      const headers = new Headers(consent.headers);
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("Cache-Control", "no-store");
      return new Response(page("Connect an app", body, { login: session.login }), { headers });
    }

    if (req.method === "POST") {
      const form = await req.formData();
      const handle = String(form.get("handle") || "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(req, handle);
        return redirect(denied.redirectTo, new Headers(denied.headers));
      }
      const approved = await oauth.approveConsent(req, handle, { scope: form.getAll("scope").map(String) });
      // Reuse the same consent descriptor rather than trusting the client name as an authenticated identity.
      const connectingClient = await oauth.describeConsent(approved.request);
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: encodeURIComponent(session.login.toLowerCase()),
        metadata: { login: session.login, connectedAt: new Date().toISOString(),
          clientName: connectingClient.clientName, clientDomain: connectingClient.clientDomain ?? null },
        scope: approved.request.scope,
        props: { login: session.login, clientName: connectingClient.clientName,
          clientDomain: connectingClient.clientDomain ?? null },
      });
      await audit(env.DB, session.login, "connected-app", null, approved.request.clientId);
      return redirect(redirectTo, new Headers(approved.headers));
    }
  } catch (error) {
    if (error instanceof AuthorizationError && (error as any).redirectTo) return redirect((error as any).redirectTo);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const msg = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
      return html(page("Could not connect", `<div class="notice err">${esc(msg)}</div>`, { login: session.login }), { status: 400 });
    }
    throw error;
  }
  return new Response("Method not allowed", { status: 405 });
}

// ---------------------------------------------------------------- approval site

function statusChip(p: Post): string {
  return `<span class="chip s-${esc(p.status)}">${esc(p.status)}</span>`;
}

function whenText(env: Env, p: Post): string {
  if (p.scheduled_at) return formatLocal(new Date(p.scheduled_at), env.TIMEZONE);
  if (p.status === "published" && p.approved_at) return `posted ${formatLocal(new Date(p.approved_at), env.TIMEZONE)}`;
  return "posts on approval";
}

function shortTime(env: Env, iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: env.TIMEZONE, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

function postCard(env: Env, p: Post): string {
  const thumbs = p.images.length
    ? `<div class="thumbs">${p.images.map((_, i) => `<img src="/media/${p.id}/${i}" alt="" loading="lazy">`).join("")}</div>`
    : "";
  const live = p.permalink ? ` · <a href="${esc(p.permalink)}" rel="noreferrer">view on Facebook</a>` : "";
  const bsky = p.bluesky?.permalink ? ` · <a href="${esc(p.bluesky.permalink)}" rel="noreferrer">view on Bluesky</a>` : "";
  return `<div class="card"><a class="stretch" href="/post/${p.id}">
    <div class="meta">${statusChip(p)}${p.label ? `<strong>${esc(p.label)}</strong>` : ""}${p.release ? `<span>${esc(p.release)}</span>` : ""}<span>${esc(whenText(env, p))}</span></div>
    <p class="caption clip">${esc(p.facebook_enabled ? p.message : (p.bluesky?.caption ?? p.message))}</p>${thumbs}</a>
    ${live || bsky ? `<div class="meta" style="margin-top:8px">${(live + bsky).slice(3)}</div>` : ""}</div>`;
}

async function dashboard(env: Env, session: Session, requestedWeek: string | null): Promise<Response> {
  await refreshScheduled(env).catch(() => undefined);
  const posts = await listPosts(env.DB, { limit: 100 });
  const currentDate = toLocalInput(new Date(), env.TIMEZONE).slice(0, 10);
  let start = weekStart(currentDate);
  try { if (requestedWeek) start = weekStart(requestedWeek); } catch { /* invalid date: show current week */ }
  const range = weekRange(start, env.TIMEZONE);
  const onCalendar = await listCalendarPosts(env.DB, range.from, range.to);
  const calendar = renderCalendar(env, onCalendar, await csrfToken(env, session), start);
  const drafts = posts.filter((p) => p.status === "draft").reverse();
  const scheduled = posts.filter((p) => p.status === "scheduled").sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""));
  const other = posts.filter((p) => !["draft", "scheduled"].includes(p.status)).slice(0, 15);
  const missing = missingSecrets(env);
  const log = await recentAudit(env.DB, 20);

  const section = (title: string, list: Post[], empty: string) =>
    `<h2>${esc(title)}</h2>${list.length ? list.map((p) => postCard(env, p)).join("") : `<p class="empty">${esc(empty)}</p>`}`;

  const body = `
    ${missing.length ? `<div class="notice err">Not fully set up. Missing secrets: ${missing.map(esc).join(", ")}.</div>` : ""}
    <div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">Weekly planner</h2><div class="row"><a class="btn" href="/tiktok/settings">TikTok settings</a><a class="btn" href="/new">+ New draft</a></div></div>
    ${calendar}
    ${section(`Waiting for you (${drafts.length})`, drafts, "No drafts waiting for review.")}
    ${section("Scheduled", scheduled, "Nothing scheduled.")}
    ${section("Recent", other, "Nothing yet.")}
    <h2>Activity</h2>
    ${log.length ? `<table class="log">${log
      .map((a) => `<tr><td class="ts">${esc(shortTime(env, a.ts))}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}${a.post_id ? ` <a href="/post/${esc(a.post_id)}">${esc(a.post_id)}</a>` : ""}</td></tr>`)
      .join("")}</table>` : `<p class="empty">No activity yet.</p>`}`;
  return html(page("GS Poster", body, { login: session.login, wide: true }));
}

/** Only creates a draft. No PIN, Graph or publishing calls are permitted here. */
async function newDraftPage(req: Request,env:Env,session:Session):Promise<Response> {
  const csrf=await csrfToken(env,session);
  const show=(fields:NewDraftFields,error?:string,status=200)=>
    html(page("New draft",renderNewDraft(fields,csrf,env.TIMEZONE,error),{login:session.login}),{status});
  if(req.method==="GET"){
    const when=newDraftPrefill(new URL(req.url).searchParams.get("when"),env.TIMEZONE);
    return show(blankNewDraft(when));
  }
  if(!sameOrigin(req))return new Response("Cross-site request refused",{status:403});
  if(Number(req.headers.get("content-length")||0)>160_000)
    return show(blankNewDraft(),"Draft form exceeds its size limit.",413);
  let form:FormData;
  try{form=await req.formData();}
  catch{return show(blankNewDraft(),"Invalid draft form.",400);}
  if(!(await checkCsrf(env,session,String(form.get("csrf")||""))))
    return show(blankNewDraft(),"Session expired. Refresh and try again.",403);
  const str=(name:string)=>String(form.get(name)||"");
  const fields:NewDraftFields={
    label:str("label"),release:str("release"),message:str("message"),
    bsCaption:str("bs_caption"),facebook:form.get("facebook")==="1",
    bluesky:form.get("bluesky")==="1",tiktok:form.get("tiktok")==="1",when:form.get("asap")==="1" ? soonestDraftTime(env.TIMEZONE) : str("when"),
    contentKind:str("content_kind") as NewDraftFields["contentKind"],
  };
  try{
    const input=parseNewDraft(fields,env.TIMEZONE,session.login);
    const created=await createPost(env.DB,input);
    await audit(env.DB,session.login,"web-drafted",created.id,created.scheduled_at || undefined).catch(()=>undefined);
    if ((req.headers.get("accept") || "").includes("application/json")) {
      return Response.json({id:created.id,updated_at:created.updated_at,status:"draft"}, {headers:{"Cache-Control":"no-store"}});
    }
    return redirect("/post/"+encodeURIComponent(created.id));
  }catch(error){
    const message=error instanceof Error?error.message:"Could not save draft.";
    if ((req.headers.get("accept") || "").includes("application/json")) {
      return Response.json({error:message},{status:400,headers:{"Cache-Control":"no-store"}});
    }
    return show(fields,message,400);
  }
}

interface PageState {
  error?: string;
  notice?: string;
  message?: string;
  when?: string;
}

async function postPage(env: Env, session: Session, id: string, state: PageState, status = 200): Promise<Response> {
  const p = await getPost(env.DB, id);
  if (!p) return html(page("Not found", `<p class="empty">That post does not exist (it may have been deleted).</p><p><a href="/">Back</a></p>`, { login: session.login }), { status: 404 });
  const csrf = await csrfToken(env, session);
  const tiktokConn = await tiktokConnection(env.DB);
  const tiktokTransfer = await getTikTokInboxTransfer(env.DB,p.id);
  const fbQueue = p.images.length > BULK_FACEBOOK_THRESHOLD && p.approved_at
    ? await getFacebookUploadProgress(env.DB, p.id, p.images.length) : null;
  const message = state.message ?? p.message;
  const checks = checkMessage(message, { hasImages: p.images.length > 0 || !!p.video || (!p.facebook_enabled && !!p.bluesky) });
  const bsChecks = p.bluesky ? checkMessage(p.bluesky.caption, { hasImages: p.bluesky.images.length > 0 || !!p.bluesky.video }) : null;
  const checkList = [
    ...checks.errors.map((e) => `<li class="e">${esc(e)}</li>`),
    ...checks.warnings.map((w) => `<li class="w">${esc(w)}</li>`),
    ...(bsChecks?.errors ?? []).map((e) => `<li class="e">Bluesky: ${esc(e)}</li>`),
    ...(bsChecks?.warnings ?? []).map((w) => `<li class="w">Bluesky: ${esc(w)}</li>`),
  ].join("");
  const thumbs = p.images.length ? `<div class="thumbs">${p.images.slice(0, 12).map((_, i) => `<img loading="lazy" src="/media/${p.id}/${i}" alt="Photo ${i + 1}">`).join("")}</div>${p.images.length > 12 ? `<details class="card"><summary>Review remaining ${p.images.length - 12} photos in order</summary><div class="thumbs">${p.images.slice(12).map((_, i) => `<img loading="lazy" src="/media/${p.id}/${i + 12}" alt="Photo ${i + 13}">`).join("")}</div></details>` : ""}` : "";
  const videoPreview = (target:"facebook"|"bluesky") =>
    '<video controls playsinline preload="metadata" style="max-width:100%;max-height:440px;border-radius:8px" src="/video/' +
    esc(p.id) + '/' + target + '"></video>';
  const whenValue = state.when ?? (p.scheduled_at ? toLocalInput(new Date(p.scheduled_at), env.TIMEZONE) : "");
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="expected_updated_at" value="${esc(p.updated_at)}">`;
  const bs = p.bluesky;
  const bsMedia = bs?.images ?? p.images.slice(0, 4).map((url) => ({ url, alt: "" }));
  const bsMediaFields = Array.from({ length: 4 }, (_, i) => {
    const item = bsMedia[i];
    return `<div><label for="bs_image_${i}">Bluesky image ${i + 1} (GitHub URL or private upload, optional)</label>
      <input type="text" id="bs_image_${i}" name="bs_image_${i}" value="${esc(item?.url ?? "")}">
      <label for="bs_alt_${i}">Alternative text from image library description</label>
      <input type="text" id="bs_alt_${i}" name="bs_alt_${i}" value="${esc(item?.alt ?? "")}"></div>`;
  }).join("");
  const patreon = bs?.patreon;


  let actions = "";
  const postVideo=p.video || p.bluesky?.video?.url;
  if (postVideo && p.tiktok_enabled && !tiktokConn) {
    actions += '<div class="card"><h2>TikTok inbox</h2><p>Connect your TikTok account first to send this video for manual publication.</p><p><a href="/tiktok/settings">Connect TikTok</a></p></div>';
  }
  if (postVideo && p.tiktok_enabled && tiktokConn) {
    if (!tiktokTransfer && ["draft","scheduled","published"].includes(p.status) && !["publishing","published"].includes(p.bluesky?.status||"")) {
      actions += `<form method="post" action="/post/${p.id}/tiktok-upload" class="card">
        ${hidden}
        <h2>Send video to TikTok inbox</h2>
        <p>This sends the MP4 to your connected TikTok account for you to review and publish in TikTok. It does not automatically post or schedule a TikTok release.</p>
        <label><input type="checkbox" name="confirm_tiktok" value="1" required>
          I understand that TikTok publication is manual and may occur at a different time from this calendar slot.</label>
        <label for="tiktok-pin">Approval PIN</label><input id="tiktok-pin" type="password" name="pin" required>
        <button class="primary" type="submit">Send video to TikTok inbox</button>
      </form>`;
    }
    if (tiktokTransfer) {
      actions += `<div class="card"><h2>TikTok inbox transfer</h2>
        <p>Status: <strong>${esc(tiktokTransfer.status.replaceAll("_"," "))}</strong></p>
        ${tiktokTransfer.error ? `<p class="notice err">${esc(tiktokTransfer.error)}</p>` : ""}
        <p class="hint">Check the TikTok app inbox to complete editing and publication. GS Poster does not publish this video automatically.</p>
        ${tiktokTransfer.publish_id?`<form method="post" action="/post/${p.id}/tiktok-status">
          ${hidden}<label for="tiktok-status-pin">Approval PIN</label>
          <input id="tiktok-status-pin" name="pin" type="password" required>
          <button type="submit">Refresh TikTok transfer status</button></form>`:""}
      </div>`;
    }
  }
  if (p.status === "draft" && (p.facebook_enabled || p.bluesky)) {
    actions += `
      <form method="post" action="/post/${p.id}/approve" class="card">
        ${hidden}
        <p class="hint">Select one or both targets. Every selected target is authorized by this approval and PIN.</p>
        <label><input type="checkbox" name="target_facebook" value="1" ${p.facebook_enabled ? "checked" : ""}> Publish to Facebook</label>
        <label for="message">Facebook caption</label>
        <textarea id="message" name="message">${esc(message)}</textarea>
        <label><input type="checkbox" name="target_bluesky" value="1" ${bs ? "checked" : ""}> Publish to Bluesky</label>
        <label for="bs_caption">Bluesky caption (300 characters)</label>
        <textarea id="bs_caption" name="bs_caption">${esc(bs?.caption ?? message.slice(0, 300))}</textarea>
        <p class="hint">Provide alternative text for each Bluesky image. When images and a Patreon card are selected, the link card appears as a reply in the same thread.</p>
        ${bsMediaFields}
        <label for="bs_video_url">Bluesky video (optional MP4 GitHub URL or private upload)</label>
        <input id="bs_video_url" type="text" name="bs_video_url" value="${esc(bs?.video?.url ?? "")}">
        <label for="bs_video_alt">Video accessibility description</label>
        <input id="bs_video_alt" type="text" name="bs_video_alt" value="${esc(bs?.video?.alt ?? "")}">
        <p class="hint">A Bluesky post can have either a video or an image gallery, not both.</p>
        <label for="bs_patreon_url">Free Patreon post URL (optional)</label>
        <input id="bs_patreon_url" type="text" name="bs_patreon_url" value="${esc(patreon?.url ?? "")}">
        <label for="bs_patreon_title">Patreon card title</label>
        <input id="bs_patreon_title" type="text" name="bs_patreon_title" value="${esc(patreon?.title ?? "")}">
        <label for="bs_patreon_description">Patreon card description</label>
        <input id="bs_patreon_description" type="text" name="bs_patreon_description" value="${esc(patreon?.description ?? "")}">
        <label for="when">Publish time (${esc(env.TIMEZONE)})</label>
        <input id="when" type="datetime-local" name="when" value="${esc(whenValue)}">
        <p class="hint">Leave empty to post the moment you approve. Otherwise between 12 minutes and 30 days from now.</p>
        ${p.images.length > 12 ? `<label><input type="checkbox" name="reviewed_all_images" value="1" required> I reviewed every photo in the full sequence above.</label>` : ""}
        <label for="pin">PIN</label>
        <input id="pin" type="password" name="pin" inputmode="numeric" autocomplete="off" required>
        <div class="row"><button class="primary">Approve and ${p.scheduled_at ? "schedule" : "post"}</button></div>
      </form>
      <details class="card"><summary>Reject instead</summary>
        <form method="post" action="/post/${p.id}/reject">${hidden}
          <label for="reason">What should the drafting assistant change? (optional)</label>
          <input id="reason" type="text" name="reason" maxlength="500">
          <div class="row"><button class="danger">Reject</button></div>
        </form>
      </details>`;
  }
  if (p.status !== "draft" && p.bluesky?.status === "failed" && p.approved_at) {
    actions += `<form method="post" action="/post/${p.id}/retry-bluesky" class="card">${hidden}
      <p>Bluesky publishing failed. Retry this approved target without reposting to Facebook.</p>
      <label for="retry-pin">PIN</label><input id="retry-pin" type="password" name="pin" inputmode="numeric" required>
      <div class="row"><button class="primary">Retry Bluesky only</button></div></form>`;
  }
  if (p.status === "cancelled") {
    actions += `<form method="post" action="/post/${p.id}/restore-cancelled" class="card">
      ${hidden}
      <h2>Reopen this cancelled post</h2>
      <p class="hint">This keeps the existing captions and media, but clears the old approval and release time. You can then replace the video and choose a new time before approving again.</p>
      <p class="hint">GS Poster will check that the previous Facebook post is no longer available. If it still exists or its status cannot be verified, reopening is blocked to avoid duplicate publication.</p>
      <label><input type="checkbox" name="confirmed_cancelled" value="1" required> I confirm this post was cancelled and has not been released on Facebook or Bluesky.</label>
      <label for="restore-pin">Approval PIN</label>
      <input id="restore-pin" name="pin" type="password" inputmode="numeric" autocomplete="off" required>
      <div class="row"><button class="primary" type="submit">Reopen as editable draft</button></div>
    </form>`;
  }
  if (p.status === "scheduled" || p.bluesky?.status === "scheduled") {
    actions += `<form method="post" action="/post/${p.id}/cancel" class="card">${hidden}
      <p>Pending for <strong>${esc(whenText(env, p))}</strong>. Cancellation stops pending targets only, not already published posts.</p>
      <label for="cancel-pin">PIN</label>
      <input id="cancel-pin" type="password" name="pin" inputmode="numeric" autocomplete="off" required>
      <div class="row"><button class="danger">Cancel pending targets</button></div>
      </form>`;
  }
  if ((p.status === "scheduled" || p.status === "draft" || p.status === "rejected") && p.scheduled_at) {
    actions += `<form method="post" action="/post/${p.id}/reschedule" class="card">${hidden}
      <h2>Change release time</h2>
      <p class="hint">Moves the pending schedule without creating another post. Facebook and Bluesky are updated together when both are pending.</p>
      <label for="move-time">New release time (${esc(env.TIMEZONE)})</label>
      <input id="move-time" type="datetime-local" name="when" value="${esc(whenValue)}" required>
      <label for="move-pin">Approval PIN</label><input id="move-pin" type="password" name="pin" required autocomplete="off">
      <div class="row"><button class="primary">Save new time</button></div></form>`;
  }
  if (p.status === "draft" || p.status === "rejected" || p.status === "scheduled") {
    actions += `<form method="post" action="/post/${p.id}/edit-caption" class="card">${hidden}
      <h2>Edit unreleased captions</h2>
      <p class="hint">Save caption changes without publishing. Media and publishing targets are fixed after approval. An approved post will be updated on Facebook where supported.</p>
      ${p.facebook_enabled ? `<label for="edit-message">Facebook caption</label><textarea id="edit-message" name="message">${esc(p.message)}</textarea>` :
        `<input type="hidden" name="message" value="${esc(p.message)}">`}
      ${p.bluesky ? `<label for="edit-bluesky">Bluesky caption (up to 300 characters)</label><textarea id="edit-bluesky" name="bs_caption">${esc(p.bluesky.caption)}</textarea>` : ""}
      <label for="edit-pin">Approval PIN</label><input id="edit-pin" type="password" name="pin" required autocomplete="off">
      <div class="row"><button class="primary">Save captions</button></div></form>`;
  }
  // Failed Facebook requests can have succeeded remotely despite a lost response.
  // Both recovery actions require a fresh PIN and explicit human reconciliation.
  if (p.status === "failed" && p.facebook_enabled && p.images.length <= BULK_FACEBOOK_THRESHOLD && p.approved_at && !p.fb_post_id) {
    actions += `<form method="post" action="/post/${p.id}/retry-facebook" class="card">${hidden}
      <p>Facebook publishing failed or returned an uncertain response. Check your Page for this exact post first. Retrying can create a duplicate if it already exists.</p>
      <label><input type="checkbox" name="confirmed_no_facebook" value="1" required> I checked Facebook and confirm this post does not exist.</label>
      <label for="facebook-retry-pin">PIN</label><input id="facebook-retry-pin" type="password" name="pin" inputmode="numeric" required>
      <div class="row"><button class="primary">Retry Facebook only</button></div></form>`;
  }
  if (fbQueue && p.status === "publishing" && fbQueue.status === "failed" && fbQueue.uploaded < fbQueue.total) {
    actions += `<form method="post" action="/post/${p.id}/resume-facebook" class="card">${hidden}
      <p>Facebook uploaded ${fbQueue.uploaded} of ${fbQueue.total} photos and paused before the final feed send.</p>
      <label for="resume-pin">PIN</label><input id="resume-pin" type="password" name="pin" inputmode="numeric" required>
      <div class="row"><button class="primary">Resume remaining uploads</button></div></form>`;
  }
  if (fbQueue && p.status === "publishing" && ["failed", "sending", "done"].includes(fbQueue.status)) {
    actions += `<div class="card"><p>The Facebook queue needs manual reconciliation. First check your Page for an existing post. Neither action sends another Facebook post.</p>
      <form method="post" action="/post/${p.id}/reconcile-facebook">${hidden}
      <label for="confirmed-fb-id">Existing Facebook post ID from this Page</label>
      <input id="confirmed-fb-id" name="facebook_post_id" type="text" required>
      <label for="reconcile-pin">PIN</label><input id="reconcile-pin" type="password" name="pin" required>
      <div class="row"><button class="primary">Mark verified Facebook post</button></div></form>
      <form method="post" action="/post/${p.id}/abandon-facebook">${hidden}
      <p class="hint">Abandon stops further sending, without deleting anything already posted.</p>
      <label for="abandon-pin">PIN</label><input id="abandon-pin" type="password" name="pin" required>
      <div class="row"><button class="danger">Abandon unresolved Facebook queue</button></div></form></div>`;
  }
  if (p.status === "failed" && !p.fb_post_id &&
      !["scheduled", "publishing", "published"].includes(p.bluesky?.status ?? "")) {
    actions += `<form method="post" action="/post/${p.id}/redraft" class="card">${hidden}
      <p>Check Facebook first. This resets an unresolved failed draft without publishing it.</p>
      <label><input type="checkbox" name="confirmed_no_facebook" value="1" required> I checked Facebook and confirm this post does not exist.</label>
      <label for="redraft-pin">PIN</label><input id="redraft-pin" type="password" name="pin" inputmode="numeric" required>
      <div class="row"><button>Move back to drafts</button></div></form>`;
  }

  const body = `
    <p><a href="/">← All posts and calendar</a></p>
    ${state.error ? `<div class="notice err">${esc(state.error)}</div>` : ""}
    ${state.notice ? `<div class="notice">${esc(state.notice)}</div>` : ""}
    ${p.error ? `<div class="notice err">Publishing error: ${esc(p.error)}</div>` : ""}
    ${p.bluesky?.error ? `<div class="notice err">Bluesky error: ${esc(p.bluesky.error)}</div>` : ""}
    ${fbQueue ? `<div class="notice">Facebook bulk upload: ${fbQueue.uploaded}/${fbQueue.total} photos. Status: ${esc(fbQueue.status)}.${fbQueue.error ? " " + esc(fbQueue.error) : ""}</div>` : ""}
    ${p.status === "rejected" && p.note ? `<div class="notice">Your note for the drafting assistant: ${esc(p.note)}</div>` : ""}
    <div class="card preview">
      <div class="meta">${statusChip(p)}${p.label ? `<strong>${esc(p.label)}</strong>` : ""}${p.release ? `<span>${esc(p.release)}</span>` : ""}<span>${esc(whenText(env, p))}</span>${p.permalink ? `<a href="${esc(p.permalink)}" rel="noreferrer">view on Facebook</a>` : ""}
        ${p.bluesky?.permalink ? `<a href="${esc(p.bluesky.permalink)}" rel="noreferrer">view on Bluesky</a>` : ""}
        <span>${esc(p.facebook_enabled ? "Facebook" : "")} ${p.bluesky ? "Bluesky: " + esc(p.bluesky.status) : ""} ${p.tiktok_enabled ? "TikTok inbox (manual publishing)" : ""}</span></div>
      ${p.facebook_enabled ? `<p class="hint">Facebook caption and media</p><p class="caption">${esc(p.message)}</p>${p.video ? videoPreview("facebook") : thumbs}` : ""}
      ${p.tiktok_enabled && !p.facebook_enabled && p.video ? `<p class="hint">TikTok MP4 preview, upload to inbox only</p>${videoPreview("facebook")}` : ""}
      ${bs ? `<p class="hint">Bluesky caption</p><p class="caption">${esc(bs.caption)}</p>
        ${bs.images.length ? `<ul class="checks">${bs.images.map((img, i) => `<li>Image ${i + 1}: ${esc(img.alt)} (${esc(img.url)})</li>`).join("")}</ul>` : ""}
        ${bs.video ? `<p class="hint">Bluesky video: ${esc(bs.video.alt)}</p>${videoPreview("bluesky")}` : ""}
        ${bs.patreon ? `<p class="meta">Patreon card: ${esc(bs.patreon.title)} | ${esc(bs.patreon.url)}</p>` : ""}` : ""}
      ${p.facebook_enabled && p.link && !p.images.length ? `<p class="meta">Link: ${esc(p.link)}</p>` : ""}
      ${checkList ? `<ul class="checks">${checkList}</ul>` : ""}
      <p class="meta" style="margin-top:10px">Drafted by ${esc(p.created_by ?? "?")} · ${esc(formatLocal(new Date(p.created_at), env.TIMEZONE))} · ${esc(p.id)}</p>
    </div>
    ${draftMediaPanel(p, csrf)}
    ${actions}`;
  return html(page(p.label || "Post", body, { login: session.login }), { status });
}

/** Private draft upload actions are authenticated, same-origin and CSRF checked.
 * They never invoke approval or release paths. */
async function draftImageAction(
  req: Request, env: Env, session: Session, id: string, action: string,
): Promise<Response> {
  const fail = (error: string, status = 400) =>
    Response.json({error}, {status, headers:{"Cache-Control":"no-store"}});
  if (!sameOrigin(req)) return fail("Cross-site upload refused.", 403);
  if (Number(req.headers.get("content-length") || 0) > 8192) return fail("Request too large.", 413);
  const input = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("Invalid upload request.");
  if (!(await checkCsrf(env, session, String(input.csrf || "")))) return fail("Session expired. Reload the draft.", 403);
  const current = await getPost(env.DB,id);
  if (!current) return fail("Post not found.",404);
  if (!["draft","rejected"].includes(current.status) || current.approved_at)
    return fail("Media cannot be changed after approval.",409);
  try {
    if (action === "upload-link") {
      const filename = String(input.filename || "");
      if (filename.length < 3 || filename.length > 200 ||
          !/\.(jpe?g|png|gif)$/i.test(filename)) return fail("Select a JPG, PNG or GIF image.");
      const grant = await createUpload(env, new URL(req.url).origin, {filename,actor:session.login});
      return Response.json({reference:grant.reference,upload_url:grant.upload_url,max_bytes:grant.max_bytes},
        {headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
    }
    if (action === "video-link") {
      const filename = String(input.filename || "");
      if (filename.length < 5 || filename.length > 200 || !/\.mp4$/i.test(filename))
        return fail("Select an MP4 video.");
      const grant = await createUpload(env,new URL(req.url).origin,{filename,actor:session.login});
      return Response.json({reference:grant.reference,upload_url:grant.upload_url,max_bytes:grant.max_bytes},
        {headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
    }
    if (action === "attach-video") {
      const reference = String(input.reference || "");
      const alt = String(input.alt || "").trim();
      const facebook = input.facebook === true;
      const bluesky = input.bluesky === true;
      const tiktok = input.tiktok === true;
      const version = String(input.expected_updated_at || "");
      if (!facebook && !bluesky && !tiktok) return fail("Select at least one video target.");
      if (tiktok && !current.tiktok_enabled) return fail("TikTok is not selected for this draft.");
      if (facebook && !current.facebook_enabled) return fail("Facebook is not selected for this draft.");
      if (bluesky && !current.bluesky) return fail("Bluesky is not selected for this draft.");
      if (bluesky && !alt) return fail("Provide alternative text for Bluesky video.");
      if (alt.length > 1000) return fail("Video alternative text is too long.");
      if (version !== current.updated_at) return fail("The draft changed. Reload.",409);
      if (!(await isStoredOwnerVideo(env.DB,reference,session.login)))
        return fail("This private video is not stored or does not belong to your account.");
      const updated = await attachDraftVideo(env.DB,id,reference,alt,facebook,bluesky,version,tiktok);
      if (!updated) return fail("A target already has media or the draft changed. Reload.",409);
      await audit(env.DB,session.login,"draft-video-attached",id,
        (facebook?"facebook ":"")+(bluesky?"bluesky":""));
      return Response.json({ok:true,updated_at:updated},{headers:{"Cache-Control":"no-store"}});
    }
    if (action === "attach-image") {
      const reference = String(input.reference || "");
      const alt = String(input.alt || "").trim();
      const facebook = input.facebook === true;
      const bluesky = input.bluesky === true;
      const expected = String(input.expected_updated_at || "");
      if (!facebook && !bluesky) return fail("Select Facebook, Bluesky or both.");
      if (facebook && !current.facebook_enabled) return fail("Facebook is not a selected draft target.");
      if (bluesky && !current.bluesky) return fail("Bluesky is not a selected draft target.");
      if (alt.length > 1000) return fail("Alternative text exceeds 1,000 characters.");
      if (bluesky && !alt) return fail("Bluesky requires image alternative text.");
      if (!expected || expected !== current.updated_at) return fail("Draft changed. Reload before attaching.",409);
      if (!(await isStoredOwnerUpload(env.DB,reference,session.login)))
        return fail("The private image is missing, incomplete, or belongs to a different session.", 400);
      const updated = await attachDraftImage(env.DB,id,reference,alt,facebook,bluesky,expected);
      if (!updated) return fail("Draft changed or image limit exceeded. Reload.",409);
      await audit(env.DB,session.login,"draft-media-attached",id,
        (facebook?"facebook ":"")+(bluesky?"bluesky":""));
      return Response.json({ok:true,updated_at:updated},{headers:{"Cache-Control":"no-store"}});
    }
    return fail("Unknown media action.",404);
  } catch(error) {
    return fail(error instanceof Error ? error.message : "Upload failed.",400);
  }
}

async function postAction(req: Request, env: Env, session: Session, id: string, action: string): Promise<Response> {
  if (!sameOrigin(req)) return new Response("Cross-site request refused", { status: 403 });
  const form = await req.formData();
  if (!(await checkCsrf(env, session, String(form.get("csrf") || "")))) {
    return postPage(env, session, id, { error: "The form expired. Reload the page and try again." }, 403);
  }

  if (action === "reject") {
    const ok = await rejectPost(env, id, String(form.get("reason") || "").slice(0, 500), session.login);
    return ok ? redirect(`/post/${id}`) : postPage(env, session, id, { error: "Only drafts can be rejected." }, 409);
  }
  // All publication, cancellation and failed-target recovery require the PIN
  const message = String(form.get("message") ?? "");
  const whenRaw = String(form.get("when") ?? "").trim();
  const keep = { message: action === "approve" ? message : undefined, when: action === "approve" ? whenRaw : undefined };
  if (!env.APPROVE_PIN) return postPage(env, session, id, { ...keep, error: "APPROVE_PIN is not set, so nothing can be approved yet." }, 503);
  if (await pinLocked(env.DB)) return postPage(env, session, id, { ...keep, error: "Too many wrong PINs. Approvals are locked for up to an hour." }, 429);
  if (!safeEqual(String(form.get("pin") || ""), env.APPROVE_PIN)) {
    await recordPinFailure(env.DB);
    await audit(env.DB, session.login, "wrong-pin", id);
    return postPage(env, session, id, { ...keep, error: "Wrong PIN." }, 403);
  }

  try {
    if (action === "tiktok-upload") {
      if (form.get("confirm_tiktok") !== "1")
        return postPage(env,session,id,{error:"Confirm that TikTok publication is manual."},400);
      await startTikTokInboxTransfer(env,id,String(form.get("expected_updated_at")||""),session.login);
      return postPage(env,session,id,{notice:"Video transferred to TikTok. Open your TikTok inbox to complete publication."});
    }
    if (action === "tiktok-status") {
      const checked=await refreshTikTokInboxTransfer(env,id,session.login);
      return postPage(env,session,id,{notice:"TikTok transfer: "+checked.status.replaceAll("_"," ")+". Publication still requires your action in TikTok."});
    }
    if (action === "restore-cancelled") {
      if (form.get("confirmed_cancelled") !== "1") {
        return postPage(env,session,id,{error:"Confirm both targets are cancelled before reopening."},400);
      }
      const version=String(form.get("expected_updated_at") || "");
      const restored=await restoreCancelledPost(env,id,version,session.login);
      return restored
        ? redirect("/post/"+id)
        : postPage(env,session,id,{error:"The post changed, or it still has an active publishing target. Reload before trying again."},409);
    }
    if (action === "resume-facebook") {
      const resumed = await resumeFailedFacebookUploads(env, id, session.login);
      return postPage(env, session, id, {
        notice: resumed ? "Remaining Facebook photos have been queued." :
          "Cannot safely resume this queue. Reconcile the Facebook post instead.",
      });
    }
    if (action === "abandon-facebook") {
      const abandoned = await abandonFacebookUpload(env, id, session.login);
      return postPage(env, session, id, {
        notice: abandoned ? "Queue abandoned. No more Facebook sends will be attempted." :
          "Queue was not eligible for abandonment.",
      });
    }
    if (action === "reconcile-facebook") {
      const facebookId = String(form.get("facebook_post_id") ?? "").trim();
      const confirmed = await markFacebookUploadPosted(env, id, facebookId, session.login);
      return postPage(env, session, id, {
        notice: confirmed ? "Verified Facebook post was recorded; no new post was sent." :
          "The Facebook post could not be reconciled.",
      });
    }
    if (action === "redraft" || action === "retry-facebook") {
      if (form.get("confirmed_no_facebook") !== "1") {
        return postPage(env, session, id, { error: "Confirm you checked Facebook for an existing post before recovering." }, 400);
      }
      if (action === "redraft") {
        const restored = await backToDraft(env, id, session.login, true);
        return restored ? redirect(`/post/${id}`) :
          postPage(env, session, id, { error: "Cannot restore a post with an active or already published target." }, 409);
      }
      const retried = await retryFailedFacebook(env, id, session.login);
      return postPage(env, session, id, {
        notice: retried ? "Facebook-only retry completed." : "Facebook retry failed. Check Facebook before another attempt.",
      });
    }
    if (action === "edit-caption") {
      const current = await getPost(env.DB, id);
      if (!current || current.updated_at !== String(form.get("expected_updated_at") || "")) {
        return postPage(env, session, id, { error: "The post changed. Reload before editing." }, 409);
      }
      const nextMessage = String(form.get("message") ?? "");
      const nextBluesky = current.bluesky ? String(form.get("bs_caption") ?? "") : null;
      if (current.facebook_enabled && !nextMessage.trim() && !current.images.length) {
        return postPage(env, session, id, { error: "Facebook requires a caption or image." }, 400);
      }
      if (current.bluesky) {
        const issues = checkBluesky({ ...current.bluesky, caption: nextBluesky! });
        if (issues.length) return postPage(env, session, id, { error: issues.join(" ") }, 400);
      }
      await editPendingCaptions(env, id, current.updated_at, nextMessage, nextBluesky, session.login);
      return postPage(env, session, id, { notice: "Pending captions updated. No post was published." });
    }
    if (action === "reschedule") {
      const current = await getPost(env.DB, id);
      if (!current || current.updated_at !== String(form.get("expected_updated_at") || "")) {
        return postPage(env, session, id, { error: "This post changed. Reload and choose the time again." }, 409);
      }
      if (!whenRaw) return postPage(env, session, id, { error: "Select a new release time." }, 400);
      let next: Date;
      try { next = localToUtc(whenRaw, env.TIMEZONE); }
      catch { return postPage(env, session, id, { error: "Invalid date or time." }, 400); }
      const minLead = current.facebook_enabled && current.images.length > BULK_FACEBOOK_THRESHOLD
        ? BULK_SCHEDULE_MIN_LEAD_MS : APPROVE_MIN_LEAD_MS;
      const error = checkWhen(next, new Date(), minLead);
      if (error) return postPage(env, session, id, { error }, 400);
      await reschedulePost(env, id, next, current.updated_at, session.login);
      const returnTo = String(form.get("return_to") || "");
      return redirect(returnTo.startsWith("/calendar?week=") ? safeNext(returnTo) : "/post/" + id);
    }
    if (action === "cancel") {
      await cancelScheduled(env, id, session.login);
      return postPage(env, session, id, { notice: "Scheduled targets cancelled." });
    }
    if (action === "retry-bluesky") {
      const succeeded = await retryFailedBluesky(env, id, session.login);
      return postPage(env, session, id, { notice: succeeded ? "Bluesky published." : "Bluesky retry failed. Review the error." });
    }
    // approve: validate the human-selected targets before the atomic publishing claim.
    const current = await getPost(env.DB, id);
    if (!current || current.status !== "draft") return postPage(env, session, id, { error: "Only drafts can be approved." }, 409);
    if (String(form.get("expected_updated_at") ?? "") !== current.updated_at) {
      return postPage(env, session, id, { error: "The draft changed since you opened this page. Reload and review the current version before approving." }, 409);
    }
    const facebook = form.get("target_facebook") === "1";
    const blueskySelected = form.get("target_bluesky") === "1";
    if (!facebook && !blueskySelected) return postPage(env, session, id, { ...keep, error: "Choose at least one target." }, 400);
    if (facebook && current.images.length > 12 && form.get("reviewed_all_images") !== "1") {
      return postPage(env, session, id, { error: "Review every photo before approving this large Facebook post." }, 400);
    }
    if (facebook && !message.trim() && !current.images.length && !current.video) {
      return postPage(env, session, id, { ...keep, error: "The Facebook post needs a caption or image." }, 400);
    }
    let bluesky: BlueskyDraft | null = null;
    if (blueskySelected) {
      const images = Array.from({ length: 4 }, (_, i) => ({
        url: String(form.get("bs_image_" + i) || "").trim(),
        alt: String(form.get("bs_alt_" + i) || "").trim(),
      })).filter((img) => img.url || img.alt);
      const patreonUrl = String(form.get("bs_patreon_url") || "").trim();
      bluesky = {
        caption: String(form.get("bs_caption") || ""),
        images,
        video: String(form.get("bs_video_url") || "").trim() || String(form.get("bs_video_alt") || "").trim()
          ? { url: String(form.get("bs_video_url") || "").trim(), alt: String(form.get("bs_video_alt") || "").trim() }
          : null,
        patreon: patreonUrl ? {
          url: patreonUrl, title: String(form.get("bs_patreon_title") || ""),
          description: String(form.get("bs_patreon_description") || ""),
        } : null,
      };
      const problems = checkBluesky(bluesky);
      if (problems.length) return postPage(env, session, id, { ...keep, error: problems.join(" ") }, 400);
    }
    let when: Date | null = null;
    if (whenRaw) {
      try {
        when = localToUtc(whenRaw, env.TIMEZONE);
      } catch {
        return postPage(env, session, id, { ...keep, error: "Could not read the publish time." }, 400);
      }
    }
    const minLead = facebook && current.images.length > BULK_FACEBOOK_THRESHOLD
      ? BULK_SCHEDULE_MIN_LEAD_MS : APPROVE_MIN_LEAD_MS;
    const timeErr = checkWhen(when, new Date(), minLead);
    if (timeErr) return postPage(env, session, id, { ...keep, error: timeErr }, 400);

    if (facebook && current.video) {
      if (current.images.length) return postPage(env,session,id,
        {error:"Facebook video cannot be combined with image gallery."},400);
      try { await fetchVideo(env,current.video); }
      catch(error) { return postPage(env,session,id,{error:"Facebook video unavailable: "+
        (error instanceof Error ? error.message : String(error))},400); }
    }
    // Human review only authorizes media that is actually readable now.
    if (bluesky) {
      for (const image of bluesky.images) {
        try { await fetchImage(env, image.url); }
        catch (error) {
          return postPage(env, session, id, {
            error: "Bluesky image could not be loaded: " +
              (error instanceof Error ? error.message : String(error)),
          }, 400);
        }
      }
      if (bluesky.video) {
        try { await fetchVideo(env, bluesky.video.url); }
        catch (error) {
          return postPage(env, session, id, {
            error: "Bluesky video could not be loaded: " +
              (error instanceof Error ? error.message : String(error)),
          }, 400);
        }
      }
    }
    const result = await approveAndPublish(env, id, {
      message, scheduledAt: when, actor: session.login,
      facebookEnabled: facebook, bluesky, expectedUpdatedAt: current.updated_at,
    });
    if (result.status === "failed") return postPage(env, session, id, { error: "A selected target failed. Review the target-specific error below." }, 502);
    return postPage(env, session, id, {
      notice: result.status === "scheduled" ? `Scheduled for ${whenText(env, result)}.` : "Approved. Review each target status below.",
    });
  } catch (e) {
    return postPage(env, session, id, { ...keep, error: e instanceof Error ? e.message : String(e) }, 409);
  }
}

/** Signed-in video preview with HTTP byte ranges for native playback. */
async function videoProxy(req: Request, env: Env, id: string, target: string): Promise<Response> {
  const p = await getPost(env.DB,id);
  const reference = target === "facebook" ? p?.video : p?.bluesky?.video?.url;
  if (!reference) return new Response("Not found",{status:404});
  try {
    const bytes = await fetchVideo(env,reference);
    const range = req.headers.get("range");
    const headers = new Headers({"Content-Type":"video/mp4","Accept-Ranges":"bytes",
      "Cache-Control":"private, max-age=300","X-Content-Type-Options":"nosniff"});
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) return new Response(null,{status:416,headers:{"Content-Range":"bytes */"+bytes.length}});
      const start=Number(match[1]), end=match[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1;
      if (start>=bytes.length || end<start)
        return new Response(null,{status:416,headers:{"Content-Range":"bytes */"+bytes.length}});
      headers.set("Content-Range","bytes "+start+"-"+end+"/"+bytes.length);
      headers.set("Content-Length",String(end-start+1));
      return new Response(bytes.slice(start,end+1),{status:206,headers});
    }
    headers.set("Content-Length",String(bytes.length));
    return new Response(bytes,{headers});
  } catch(error) {
    return new Response(error instanceof Error ? error.message : "Could not load video",{status:502});
  }
}

async function mediaProxy(env: Env, id: string, n: number, thumbnail = false): Promise<Response> {
  const p = await getPost(env.DB, id);
  const url = p?.images[n] ?? p?.bluesky?.images[n]?.url;
  if (!url) return new Response("Not found", { status: 404 });
  try {
    const img = await fetchImage(env, url);
    if (thumbnail) {
      if (!env.IMAGES) return new Response("Thumbnail transformer unavailable", { status: 503 });
      const reduced = await env.IMAGES.input(new Blob([img.bytes]).stream())
        .transform({ width: 112, height: 112, fit: "cover" })
        .output({ format: "image/webp", quality: 58, anim: false });
      const response = await reduced.response();
      return new Response(response.body, {
        headers: { "Content-Type": "image/webp", "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff" },
      });
    }
    return new Response(img.bytes, {
      headers: { "Content-Type": img.type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" },
    });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "Could not load image", { status: 502 });
  }
}
