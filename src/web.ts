/**
 * The human side: GitHub sign-in, the OAuth consent page for connecting
 * Claude, and the approval page where Gus approves, edits, rejects or cancels.
 */
import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { allowedLogins, missingSecrets, type Env } from "./env.ts";
import { audit, getPost, lastAudit, listPosts, pinLocked, recentAudit, recordPinFailure, type Post } from "./db.ts";
import { checkPage } from "./facebook.ts";
import { esc, html, page } from "./html.ts";
import { fetchImage } from "./media.ts";
import { approveAndPublish, backToDraft, cancelScheduled, refreshScheduled, rejectPost, saveEdits } from "./publish.ts";
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
import { dayLabel, formatLocal, localToUtc, toLocalInput } from "./time.ts";
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
  const self = new URL(req.url).origin;
  const origin = req.headers.get("Origin");
  if (origin && origin !== self) return false;
  const site = req.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return false;
  return true;
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
  if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /privacy\nDisallow: /\n");
  if (path === "/privacy") return html(page("Privacy", PRIVACY, { indexable: true }));
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

  if (path === "/" && req.method === "GET") return dashboard(env, session);
  if (path === "/setup" && req.method === "GET") return setupPage(env, session, url.origin);

  const m = /^\/post\/(p_[a-z0-9]+)(?:\/(approve|reject|cancel|redraft|save))?$/.exec(path);
  if (m) {
    const [, id, action] = m;
    if (!action && req.method === "GET") {
      return postPage(env, session, id, url.searchParams.has("saved") ? { notice: "Saved. Nothing goes to Facebook until you approve it." } : {});
    }
    if (action && req.method === "POST") return postAction(req, env, session, id, action);
  }
  const media = /^\/media\/(p_[a-z0-9]+)\/(\d+)$/.exec(path);
  if (media && req.method === "GET") return mediaProxy(env, media[1], Number(media[2]));

  return html(page("Not found", `<p class="empty">Nothing here.</p>`, { login: session.login }), { status: 404 });
}

// ---------------------------------------------------------------- public pages

// Meta asks for a privacy policy URL before the app can go Live, and posts
// from an app in Development mode are only shown to people with a role on it.
const PRIVACY = `
  <h2>Privacy</h2>
  <div class="card prose">
    <p>GS Poster is a private tool. GS Grimoire uses it to prepare and schedule posts on its own Facebook Page. It is not offered to anyone else.</p>
    <h3>Who uses it</h3>
    <p>Only the GS Grimoire account holder, after signing in with an approved GitHub account. Claude, an AI assistant, can write drafts through it but cannot publish them.</p>
    <h3>What it stores</h3>
    <ul>
      <li>Post drafts: captions, links to images, planned times, and the Facebook id of each post once it is published.</li>
      <li>A log of who drafted, approved, rejected or cancelled each post.</li>
      <li>The GitHub username of the person signed in. GitHub's sign-in token is discarded straight away.</li>
    </ul>
    <h3>What it reads from Facebook</h3>
    <p>Only the GS Grimoire Page itself: its name and follower count, its recent and scheduled posts, and the number of reactions, comments and shares on them. It does not collect information about the people who follow the Page or interact with it.</p>
    <p>Nothing is sold or shared. The data is held by Cloudflare, which runs the service. The Facebook access token is kept as an encrypted secret and is never shown in the app.</p>
    <h3 id="deletion">Deleting data</h3>
    <p>To have GS Poster's data deleted, send a message to the GS Grimoire Facebook Page. Removing GS Poster's access in your Facebook settings (Business integrations, or Apps and websites) stops all further access straight away.</p>
  </div>`;

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
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: encodeURIComponent(session.login.toLowerCase()),
        metadata: { login: session.login, connectedAt: new Date().toISOString() },
        scope: approved.request.scope,
        props: { login: session.login },
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

/** Why a draft's planned time won't work any more, or null if it's fine. */
function timeProblem(env: Env, p: Post): string | null {
  if (p.status !== "draft" || !p.scheduled_at) return null;
  const when = new Date(p.scheduled_at);
  if (when.getTime() <= Date.now()) {
    return `The planned time, ${formatLocal(when, env.TIMEZONE)}, has passed. Pick a new time, or clear it to post when you approve.`;
  }
  return checkWhen(when, new Date(), APPROVE_MIN_LEAD_MS);
}

function postCard(env: Env, p: Post): string {
  const thumbs = p.images.length
    ? `<div class="thumbs">${p.images.map((_, i) => `<img src="/media/${p.id}/${i}" alt="" loading="lazy">`).join("")}</div>`
    : "";
  const live = p.permalink ? ` · <a href="${esc(p.permalink)}" rel="noreferrer">view on Facebook</a>` : "";
  const late = timeProblem(env, p) ? `<span class="late">needs a new time</span>` : "";
  return `<div class="card"><a class="stretch" href="/post/${p.id}">
    <div class="meta">${statusChip(p)}${p.label ? `<strong>${esc(p.label)}</strong>` : ""}${p.release ? `<span>${esc(p.release)}</span>` : ""}<span>${esc(whenText(env, p))}</span>${late}</div>
    <p class="caption clip">${esc(p.message)}</p>${thumbs}</a>
    ${live ? `<div class="meta" style="margin-top:8px">${live.slice(3)}</div>` : ""}</div>`;
}

/** Posts on approval first, then soonest first. */
function byPublishTime(a: Post, b: Post): number {
  return (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "");
}

/** Cards under a heading per day, so a release reads as a timeline. */
function byDay(env: Env, list: Post[]): string {
  let last = "";
  return list
    .map((p) => {
      const day = p.scheduled_at ? dayLabel(new Date(p.scheduled_at), env.TIMEZONE) : "On approval";
      const head = day === last ? "" : `<h3 class="day">${esc(day)}</h3>`;
      last = day;
      return head + postCard(env, p);
    })
    .join("");
}

async function dashboard(env: Env, session: Session): Promise<Response> {
  await refreshScheduled(env).catch(() => undefined);
  const posts = await listPosts(env.DB, { limit: 100 });
  const drafts = posts.filter((p) => p.status === "draft").sort(byPublishTime);
  const scheduled = posts.filter((p) => p.status === "scheduled").sort(byPublishTime);
  const other = posts.filter((p) => !["draft", "scheduled"].includes(p.status)).slice(0, 15);
  const missing = missingSecrets(env);
  const log = await recentAudit(env.DB, 20);

  const section = (title: string, list: Post[], empty: string, render: (list: Post[]) => string) =>
    `<h2>${esc(title)}</h2>${list.length ? render(list) : `<p class="empty">${esc(empty)}</p>`}`;
  const timeline = (list: Post[]) => byDay(env, list);
  const plain = (list: Post[]) => list.map((p) => postCard(env, p)).join("");

  const body = `
    ${missing.length ? `<div class="notice err">Not fully set up. Missing secrets: ${missing.map(esc).join(", ")}. <a href="/setup">Open the setup check</a>.</div>` : ""}
    ${section(`Waiting for you (${drafts.length})`, drafts, "No drafts. Claude's drafts show up here.", timeline)}
    ${section("Scheduled on Facebook", scheduled, "Nothing scheduled.", timeline)}
    ${section("Recent", other, "Nothing yet.", plain)}
    <h2>Activity</h2>
    ${log.length ? `<table class="log">${log
      .map((a) => `<tr><td class="ts">${esc(shortTime(env, a.ts))}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}${a.post_id ? ` <a href="/post/${esc(a.post_id)}">${esc(a.post_id)}</a>` : ""}</td></tr>`)
      .join("")}</table>` : `<p class="empty">No activity yet.</p>`}`;
  return html(page("GS Poster", body, { login: session.login }));
}

/** What is set up and what isn't, with a live check of the Facebook token. Shows no secret values. */
async function setupPage(env: Env, session: Session, origin: string): Promise<Response> {
  const row = (state: "ok" | "bad" | "opt", title: string, hint = "") =>
    `<li class="${state}"><span class="mark">${state === "ok" ? "✓" : state === "bad" ? "✗" : "–"}</span><span>${title}</span>${hint ? `<span class="hint">${hint}</span>` : ""}</li>`;

  let facebook: string;
  if (!env.FB_PAGE_ID || !env.FB_PAGE_TOKEN) {
    facebook = row("bad", "Facebook Page not set up", "Add the FB_PAGE_ID and FB_PAGE_TOKEN secrets in Cloudflare.");
  } else {
    try {
      const fb = await checkPage(env);
      facebook = row("ok", `Facebook: connected to <strong>${esc(fb.name)}</strong>`, fb.followers == null ? "" : `${esc(fb.followers)} followers.`);
    } catch (e) {
      facebook = row("bad", "Facebook token does not work", esc(e instanceof Error ? e.message : String(e)));
    }
  }
  const connected = await lastAudit(env.DB, "connected-app");

  const items = [
    row("ok", "GitHub sign-in", `Signed in as ${esc(session.login)}.`),
    env.APPROVE_PIN ? row("ok", "Approval PIN is set") : row("bad", "Approval PIN is missing", "Add the APPROVE_PIN secret: 6 or more digits only you know."),
    facebook,
    env.FB_APP_SECRET
      ? row("ok", "Token locked to your Meta app")
      : row("opt", "Token not locked to your Meta app", "Optional, recommended: add FB_APP_SECRET, then turn on “Require app secret” in Meta."),
    row("opt", "Meta app in Live mode?", "This can't be checked from here. In Development mode, only people with a role on the app see its posts."),
    connected
      ? row("ok", "Claude has been connected", `Last connected ${esc(shortTime(env, connected.ts))}.`)
      : row("bad", "Claude is not connected yet", "In claude.ai, add a custom connector with the MCP address below."),
    env.GITHUB_READ_TOKEN
      ? row("ok", "Images from private repos")
      : row("opt", "Images from private repos are off", "Optional: add GITHUB_READ_TOKEN (Contents: read) if images live in a private repo."),
  ];
  const address = (label: string, value: string) => `<label>${esc(label)}</label><code>${esc(value)}</code>`;
  const body = `
    <p><a href="/">← All posts</a></p>
    <h2>Setup check</h2>
    <div class="card"><ul class="setup">${items.join("")}</ul></div>
    <h2>Addresses</h2>
    <div class="card">
      ${address("MCP server, for the Claude connector", `${origin}/mcp`)}
      ${address("GitHub OAuth app callback URL", `${origin}/callback`)}
      ${address("Privacy policy and data deletion URL, for Meta", `${origin}/privacy`)}
    </div>`;
  return html(page("Setup check", body, { login: session.login }));
}

interface PageState {
  error?: string;
  notice?: string;
  message?: string;
  when?: string;
}

const PAGE_NAME = "GS Grimoire";

/** The post roughly as it will look in the Page's feed, with Facebook's photo grid. */
function fbPreview(env: Env, p: Post): string {
  const shown = p.images.slice(0, 5);
  const extra = p.images.length - shown.length;
  const tile = (i: number) =>
    `<a href="/media/${p.id}/${i}" target="_blank" rel="noopener"><img src="/media/${p.id}/${i}" alt="Image ${i + 1}">${extra && i === 4 ? `<span class="fb-more">+${extra}</span>` : ""}</a>`;
  const media = shown.length ? `<div class="fb-media n${shown.length}">${shown.map((_, i) => tile(i)).join("")}</div>` : "";
  const link = p.link && !p.images.length ? `<div class="fb-link">${esc(p.link)}</div>` : "";
  const all = extra
    ? `<details class="card"><summary>All ${p.images.length} images</summary><div class="thumbs">${p.images.map((_, i) => `<img src="/media/${p.id}/${i}" alt="" loading="lazy">`).join("")}</div></details>`
    : "";
  return `<div class="fb">
      <div class="fb-head"><span class="fb-avatar" aria-hidden="true">GS</span><div><strong>${esc(PAGE_NAME)}</strong><span class="fb-when">${esc(whenText(env, p))}</span></div></div>
      <p class="fb-text">${esc(p.message)}</p>${media}${link}
      <div class="fb-bar" aria-hidden="true"><span>Like</span><span>Comment</span><span>Share</span></div>
    </div>${all}`;
}

async function postPage(env: Env, session: Session, id: string, state: PageState, status = 200): Promise<Response> {
  const p = await getPost(env.DB, id);
  if (!p) return html(page("Not found", `<p class="empty">That post does not exist (it may have been deleted).</p><p><a href="/">Back</a></p>`, { login: session.login }), { status: 404 });
  const csrf = await csrfToken(env, session);
  const message = state.message ?? p.message;
  const checks = checkMessage(message, { hasImages: p.images.length > 0 });
  const checkList = [...checks.errors.map((e) => `<li class="e">${esc(e)}</li>`), ...checks.warnings.map((w) => `<li class="w">${esc(w)}</li>`)].join("");
  const late = timeProblem(env, p);
  const whenValue = state.when ?? (p.scheduled_at ? toLocalInput(new Date(p.scheduled_at), env.TIMEZONE) : "");
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

  let actions = "";
  if (p.status === "draft") {
    actions = `
      <form method="post" action="/post/${p.id}/approve" class="card">
        ${hidden}
        <label for="message">Caption</label>
        <textarea id="message" name="message">${esc(message)}</textarea>
        <label for="when">Publish time (${esc(env.TIMEZONE)})</label>
        <input id="when" type="datetime-local" name="when" value="${esc(whenValue)}">
        <p class="hint">Leave empty to post the moment you approve. Otherwise between 12 minutes and 30 days from now.</p>
        <label for="pin">PIN</label>
        <input id="pin" type="password" name="pin" inputmode="numeric" autocomplete="off" required>
        <div class="row"><button class="primary">Approve and ${p.scheduled_at ? "schedule" : "post"}</button><button formaction="/post/${p.id}/save" formnovalidate>Save changes</button></div>
        <p class="hint">Save changes keeps your edits and updates the preview without posting. No PIN needed.</p>
      </form>
      <details class="card"><summary>Reject instead</summary>
        <form method="post" action="/post/${p.id}/reject">${hidden}
          <label for="reason">What should Claude change? (optional)</label>
          <input id="reason" type="text" name="reason" maxlength="500">
          <div class="row"><button class="danger">Reject</button></div>
        </form>
      </details>`;
  } else if (p.status === "scheduled") {
    actions = `
      <form method="post" action="/post/${p.id}/cancel" class="card">${hidden}
        <p>Scheduled for <strong>${esc(whenText(env, p))}</strong>. You can also change or cancel it in Meta Business Suite.</p>
        <label for="pin">PIN</label>
        <input id="pin" type="password" name="pin" inputmode="numeric" autocomplete="off" required>
        <div class="row"><button class="danger">Cancel this post</button></div>
      </form>`;
  } else if (p.status === "failed" || p.status === "rejected") {
    actions = `<form method="post" action="/post/${p.id}/redraft" class="card">${hidden}
      <div class="row"><button>Move back to drafts</button></div></form>`;
  }

  const body = `
    <p><a href="/">← All posts</a></p>
    ${state.error ? `<div class="notice err">${esc(state.error)}</div>` : ""}
    ${state.notice ? `<div class="notice">${esc(state.notice)}</div>` : ""}
    ${p.error ? `<div class="notice err">Facebook error: ${esc(p.error)}</div>` : ""}
    ${p.status === "rejected" && p.note ? `<div class="notice">Your note to Claude: ${esc(p.note)}</div>` : ""}
    ${p.status === "draft" && p.note ? `<div class="notice"><strong>Your note when you rejected it:</strong> “${esc(p.note)}”<br>Check this version against it.</div>` : ""}
    ${late ? `<div class="notice warn">${esc(late)}</div>` : ""}
    <div class="meta" style="margin-bottom:10px">${statusChip(p)}${p.label ? `<strong>${esc(p.label)}</strong>` : ""}${p.release ? `<span>${esc(p.release)}</span>` : ""}${p.permalink ? `<a href="${esc(p.permalink)}" rel="noreferrer">view on Facebook</a>` : ""}</div>
    ${fbPreview(env, p)}
    ${checkList ? `<div class="card"><strong class="hint">House rules</strong><ul class="checks">${checkList}</ul></div>` : ""}
    <p class="meta">Drafted by ${esc(p.created_by ?? "?")} · ${esc(formatLocal(new Date(p.created_at), env.TIMEZONE))} · ${esc(p.id)}</p>
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
  if (action === "redraft") {
    await backToDraft(env, id, session.login);
    return redirect(`/post/${id}`);
  }
  if (action === "save") {
    const message = String(form.get("message") ?? "");
    const whenRaw = String(form.get("when") ?? "").trim();
    let when: Date | null = null;
    if (whenRaw) {
      try {
        when = localToUtc(whenRaw, env.TIMEZONE);
      } catch {
        return postPage(env, session, id, { message, when: whenRaw, error: "Could not read the publish time." }, 400);
      }
    }
    const ok = await saveEdits(env, id, { message, scheduledAt: when, actor: session.login });
    return ok ? redirect(`/post/${id}?saved=1`) : postPage(env, session, id, { error: "Only drafts can be edited." }, 409);
  }

  // approve and cancel need the PIN
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
    if (action === "cancel") {
      await cancelScheduled(env, id, session.login);
      return postPage(env, session, id, { notice: "Cancelled. It has been removed from Facebook's schedule." });
    }
    // approve
    if (!message.trim() && !((await getPost(env.DB, id))?.images.length)) {
      return postPage(env, session, id, { ...keep, error: "The caption is empty and there are no images." }, 400);
    }
    let when: Date | null = null;
    if (whenRaw) {
      try {
        when = localToUtc(whenRaw, env.TIMEZONE);
      } catch {
        return postPage(env, session, id, { ...keep, error: "Could not read the publish time." }, 400);
      }
    }
    const timeErr = checkWhen(when, new Date(), APPROVE_MIN_LEAD_MS);
    if (timeErr) return postPage(env, session, id, { ...keep, error: timeErr }, 400);

    const result = await approveAndPublish(env, id, { message, scheduledAt: when, actor: session.login });
    if (result.status === "failed") return postPage(env, session, id, { error: "Facebook did not accept the post. See the error below; fix it and move it back to drafts." }, 502);
    return postPage(env, session, id, {
      notice: result.status === "scheduled" ? `Scheduled for ${whenText(env, result)}.` : "Posted.",
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
