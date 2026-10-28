/**
 * The human side: GitHub sign-in, the OAuth consent page for connecting
 * Claude, and the approval page where Gus approves, edits, rejects or cancels.
 */
import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { allowedLogins, missingSecrets, type Env } from "./env.ts";
import { audit, getPost, listPosts, listCalendarPosts, pinLocked, recentAudit, recordPinFailure, type BlueskyDraft, type Post } from "./db.ts";
import { checkBluesky } from "./bluesky.ts";
import { esc, html, page } from "./html.ts";
import { CALENDAR_JS, renderCalendar, weekStart, weekRange } from "./calendar.ts";
import { fetchImage } from "./media.ts";
import { fetchVideo } from "./video.ts";
import {
  getFacebookUploadProgress, resumeFailedFacebookUploads, abandonFacebookUpload,
  markFacebookUploadPosted, BULK_FACEBOOK_THRESHOLD, BULK_SCHEDULE_MIN_LEAD_MS,
} from "./facebook-queue.ts";
import { approveAndPublish, backToDraft, cancelScheduled, refreshScheduled, rejectPost, retryFailedBluesky, retryFailedFacebook, reschedulePost } from "./publish.ts";
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

  if (path === "/health") return Response.json({ ok: true });
  if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n");
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

  if (path === "/calendar.js" && req.method === "GET") return new Response(CALENDAR_JS, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  if ((path === "/" || path === "/calendar") && req.method === "GET") return dashboard(env, session, url.searchParams.get("week"));

  const m = /^\/post\/(p_[a-z0-9]+)(?:\/(approve|reject|cancel|redraft|retry-bluesky|retry-facebook|resume-facebook|abandon-facebook|reconcile-facebook|reschedule))?$/.exec(path);
  if (m) {
    const [, id, action] = m;
    if (!action && req.method === "GET") return postPage(env, session, id, {});
    if (action && req.method === "POST") return postAction(req, env, session, id, action);
  }
  const media = /^\/media\/(p_[a-z0-9]+)\/(\d+)$/.exec(path);
  if (media && req.method === "GET") return mediaProxy(env, media[1], Number(media[2]));

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
      const connectingClient = await oauth.describeConsent(approved.request);
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: encodeURIComponent(session.login.toLowerCase()),
        metadata: { login: session.login, connectedAt: new Date().toISOString(), clientName: connectingClient.clientName },
        scope: approved.request.scope,
        props: { login: session.login, clientName: connectingClient.clientName },
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
    <h2>Weekly planner</h2>
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
  const fbQueue = p.images.length > BULK_FACEBOOK_THRESHOLD && p.approved_at
    ? await getFacebookUploadProgress(env.DB, p.id, p.images.length) : null;
  const message = state.message ?? p.message;
  const checks = checkMessage(message, { hasImages: p.images.length > 0 || (!p.facebook_enabled && !!p.bluesky) });
  const bsChecks = p.bluesky ? checkMessage(p.bluesky.caption, { hasImages: p.bluesky.images.length > 0 }) : null;
  const checkList = [
    ...checks.errors.map((e) => `<li class="e">${esc(e)}</li>`),
    ...checks.warnings.map((w) => `<li class="w">${esc(w)}</li>`),
    ...(bsChecks?.errors ?? []).map((e) => `<li class="e">Bluesky: ${esc(e)}</li>`),
    ...(bsChecks?.warnings ?? []).map((w) => `<li class="w">Bluesky: ${esc(w)}</li>`),
  ].join("");
  const thumbs = p.images.length ? `<div class="thumbs">${p.images.slice(0, 12).map((_, i) => `<img loading="lazy" src="/media/${p.id}/${i}" alt="Photo ${i + 1}">`).join("")}</div>${p.images.length > 12 ? `<details class="card"><summary>Review remaining ${p.images.length - 12} photos in order</summary><div class="thumbs">${p.images.slice(12).map((_, i) => `<img loading="lazy" src="/media/${p.id}/${i + 12}" alt="Photo ${i + 13}">`).join("")}</div></details>` : ""}` : "";
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
  if (p.status === "draft") {
    actions = `
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
          <label for="reason">What should Claude change? (optional)</label>
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
    ${p.status === "rejected" && p.note ? `<div class="notice">Your note to Claude: ${esc(p.note)}</div>` : ""}
    <div class="card preview">
      <div class="meta">${statusChip(p)}${p.label ? `<strong>${esc(p.label)}</strong>` : ""}${p.release ? `<span>${esc(p.release)}</span>` : ""}<span>${esc(whenText(env, p))}</span>${p.permalink ? `<a href="${esc(p.permalink)}" rel="noreferrer">view on Facebook</a>` : ""}
        ${p.bluesky?.permalink ? `<a href="${esc(p.bluesky.permalink)}" rel="noreferrer">view on Bluesky</a>` : ""}
        <span>${esc(p.facebook_enabled ? "Facebook" : "")} ${p.bluesky ? "Bluesky: " + esc(p.bluesky.status) : ""}</span></div>
      ${p.facebook_enabled ? `<p class="hint">Facebook caption and images</p><p class="caption">${esc(p.message)}</p>${thumbs}` : ""}
      ${bs ? `<p class="hint">Bluesky caption</p><p class="caption">${esc(bs.caption)}</p>
        ${bs.images.length ? `<ul class="checks">${bs.images.map((img, i) => `<li>Image ${i + 1}: ${esc(img.alt)} (${esc(img.url)})</li>`).join("")}</ul>` : ""}
        ${bs.video ? `<p class="meta">Bluesky video: ${esc(bs.video.url)} (${esc(bs.video.alt)})</p>` : ""}
        ${bs.patreon ? `<p class="meta">Patreon card: ${esc(bs.patreon.title)} | ${esc(bs.patreon.url)}</p>` : ""}` : ""}
      ${p.facebook_enabled && p.link && !p.images.length ? `<p class="meta">Link: ${esc(p.link)}</p>` : ""}
      ${checkList ? `<ul class="checks">${checkList}</ul>` : ""}
      <p class="meta" style="margin-top:10px">Drafted by ${esc(p.created_by ?? "?")} · ${esc(formatLocal(new Date(p.created_at), env.TIMEZONE))} · ${esc(p.id)}</p>
    </div>
    ${actions}`;
  return html(page(p.label || "Post", body, { login: session.login }), { status });
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
    if (action === "reschedule") {
      const current = await getPost(env.DB, id);
      if (!current || current.updated_at !== String(form.get("expected_updated_at") || "")) {
        return postPage(env, session, id, { error: "This post changed. Reload and choose the time again." }, 409);
      }
      if (!whenRaw) return postPage(env, session, id, { error: "Select a new release time." }, 400);
      let next: Date;
      try { next = localToUtc(whenRaw, env.TIMEZONE); }
      catch { return postPage(env, session, id, { error: "Invalid date or time." }, 400); }
      const error = checkWhen(next, new Date(), APPROVE_MIN_LEAD_MS);
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
    if (facebook && !message.trim() && !current.images.length) {
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

async function mediaProxy(env: Env, id: string, n: number): Promise<Response> {
  const p = await getPost(env.DB, id);
  const url = p?.images[n];
  if (!url) return new Response("Not found", { status: 404 });
  try {
    const img = await fetchImage(env, url);
    return new Response(img.bytes, {
      headers: { "Content-Type": img.type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" },
    });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "Could not load image", { status: 502 });
  }
}
