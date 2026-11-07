/**
 * Threads settings page, PIN-gated connect and disconnect, and the sign-in
 * callback. Publishes nothing and never puts a token in HTML.
 * Same gates as TikTok account administration (CLAUDE.md, issue #73):
 * allowlisted session, same-origin, per-session CSRF, the approval PIN and
 * the shared five-failure lockout.
 */
import type { Env } from "./env.ts";
import { audit, pinLocked, recordPinFailure } from "./db.ts";
import { esc, html, page } from "./html.ts";
import { checkCsrf, csrfToken, readSession, safeEqual, type Session } from "./session.ts";
import { isSameOrigin } from "./origin.ts";
import { formatLocal } from "./time.ts";
import {
  beginThreadsConnection, clearThreadsStateCookie, disconnectThreads, finishThreadsConnection,
  threadsConfigured, threadsConnection, threadsRedirect, threadsStateCookie,
} from "./threads.ts";

/** Same-site navigation to Threads, so the strict form-action CSP is never crossed by a redirect. */
export const THREADS_CONNECT_JS = String.raw`
(() => {
  const link = document.getElementById("threads-continue-link");
  if (!link) return;
  try {
    const target = new URL(link.href);
    if (target.protocol !== "https:" || target.hostname !== "threads.net" || target.pathname !== "/oauth/authorize") return;
    window.location.replace(target.href);
  } catch {
    // The visible link stays as the manual fallback.
  }
})();
`;

const fail = (message: string, status = 400, login?: string) =>
  html(page("Threads connection", `<h2>Threads connection</h2>
    <div class="notice err" role="alert">${esc(message)}</div>
    <p><a href="/threads/settings">Back to Threads settings</a></p>`, { login }), { status });

const redirect = (location: string, cookieValue?: string): Response => {
  const h = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (cookieValue) h.append("Set-Cookie", cookieValue);
  return new Response(null, { status: 303, headers: h });
};

export async function threadsSettings(env: Env, session: Session, notice = ""): Promise<Response> {
  const conn = await threadsConnection(env.DB);
  const csrf = await csrfToken(env, session);
  const pinField = (id: string) => `<label for="${id}">Approval PIN</label>
      <input type="password" name="pin" id="${id}" inputmode="numeric" autocomplete="off" required>`;
  const status = !threadsConfigured(env)
    ? `<div class="notice">Threads is not set up yet: add the <code>THREADS_APP_ID</code> and <code>THREADS_APP_SECRET</code> Worker secrets in Cloudflare.</div>`
    : conn
      ? `<div class="card"><h3>${conn.suspended_at == null ? "Connected as" : "Posting suspended for"} @${esc(conn.username || conn.user_id)}</h3>
          ${conn.suspended_at != null ? `<div class="notice err" role="alert">A signed Threads account deauthorization or deletion callback suspended this authorization. No scheduled Threads post can be sent with this sign-in. To recover, disconnect below with your approval PIN, then connect and authorize Threads again. A replayed valid callback may require another reconnection.</div>` : `<p class="hint">Sign-in valid until ${esc(formatLocal(new Date(conn.expires_at * 1000), env.TIMEZONE))}. GS Poster renews it automatically about two weeks before then.</p>`}
          <form method="post" action="/threads/disconnect">
            <input type="hidden" name="csrf" value="${esc(csrf)}">
            <label><input type="checkbox" name="confirm" value="yes" required> Disconnect this Threads account and delete its stored sign-in</label>
            ${pinField("threads-disconnect-pin")}
            <button type="submit">Disconnect Threads</button>
          </form></div>`
      : `<form method="post" action="/threads/connect" class="card">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <h3>Connect Threads</h3>
          <p class="hint">Sign in as GS Grimoire on the Threads page that opens, and allow GS Poster to read the profile and publish posts you approve.</p>
          ${pinField("threads-connect-pin")}
          <button class="primary" type="submit">Connect Threads</button>
          <p class="hint">Connecting posts nothing. Each Threads post still needs its own PIN approval.</p>
        </form>`;
  const notices: Record<string, string> = {
    connected: '<div class="notice ok">Threads connected. Review any failed scheduled Threads jobs and retry them with your approval PIN.</div>',
    disconnected: '<div class="notice ok">Threads disconnected. Its stored sign-in was deleted. To remove the app on the Threads side too, open Threads Settings, Account, Website permissions.</div>',
  };
  return html(page("Threads settings", `<h2>Threads</h2>
    ${notices[notice] ?? ""}
    ${status}
    <p class="hint">Callback address registered with Meta: <code>${esc(threadsRedirect(env))}</code></p>
    <p><a href="/">Back to the planner</a></p>`, { login: session.login }));
}

export async function threadsSettingsAction(req: Request, env: Env, session: Session, action: string): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  if (!isSameOrigin(new URL(req.url).origin, req.headers.get("Origin"), req.headers.get("Sec-Fetch-Site")))
    return fail("Cross-site request refused.", 403, session.login);
  if (Number(req.headers.get("content-length") || 0) > 8192) return fail("Request too large.", 413, session.login);
  const form = await req.formData().catch(() => null);
  if (!form || !await checkCsrf(env, session, String(form.get("csrf") || "")))
    return fail("Form expired. Reload and try again.", 403, session.login);
  // Connecting grants and disconnecting removes posting access: same PIN and lockout as approval.
  if (!env.APPROVE_PIN) return fail("Approval PIN is not configured. Threads settings are locked.", 503, session.login);
  if (await pinLocked(env.DB)) return fail("Too many wrong PINs. Approvals and account settings are locked for up to an hour.", 429, session.login);
  if (!safeEqual(String(form.get("pin") || ""), env.APPROVE_PIN)) {
    await recordPinFailure(env.DB);
    await audit(env.DB, session.login, "wrong-pin", null, "threads-account-admin").catch(() => undefined);
    return fail("Wrong PIN.", 403, session.login);
  }
  try {
    if (action === "connect") {
      if (await threadsConnection(env.DB)) throw new Error("Disconnect the current Threads account before connecting again.");
      const link = await beginThreadsConnection(env, session);
      const res = html(page("Continue to Threads", `<h2>Connect Threads</h2>
        <p>Opening Threads to authorize GS Poster. If nothing happens, select the link below.</p>
        <p><a id="threads-continue-link" class="btn" rel="noreferrer" href="${esc(link.url)}">Continue to Threads</a></p>
        <script src="/threads-connect.js" defer></script>`, { login: session.login }));
      res.headers.set("Set-Cookie", threadsStateCookie(link.state));
      res.headers.set("Cache-Control", "no-store");
      res.headers.set("Referrer-Policy", "no-referrer");
      return res;
    }
    if (action === "disconnect") {
      if (form.get("confirm") !== "yes") throw new Error("Please confirm disconnection.");
      await disconnectThreads(env.DB);
      await audit(env.DB, session.login, "threads-account-disconnected", null).catch(() => undefined);
      return redirect("/threads/settings?notice=disconnected");
    }
    return new Response("Not found", { status: 404 });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Threads request failed.", 400, session.login);
  }
}

/** GET /threads/callback: cannot take a PIN, so it only finishes a state the PIN-gated connect issued. */
export async function threadsCallback(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  const session = await readSession(env, req);
  if (!session) return fail("Your GitHub session expired. Start connecting Threads again.", 401);
  if (!env.APPROVE_PIN) return fail("Approval PIN is not configured. Threads settings are locked.", 503, session.login);
  if (await pinLocked(env.DB)) return fail("Too many wrong PINs. Approvals and account settings are locked for up to an hour.", 429, session.login);
  try {
    const conn = await finishThreadsConnection(env, session, req);
    await audit(env.DB, session.login, "threads-account-connected", null, "@" + conn.username).catch(() => undefined);
    return redirect("/threads/settings?notice=connected", clearThreadsStateCookie());
  } catch (error) {
    const res = fail(error instanceof Error ? error.message : "Threads sign-in failed.", 400, session.login);
    res.headers.append("Set-Cookie", clearThreadsStateCookie());
    return res;
  }
}
