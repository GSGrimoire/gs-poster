/**
 * Threads account connection (Threads API, graph.threads.net). Publishes
 * nothing: approved posts go through threads-publish.ts.
 *
 * - Connect starts only from the PIN-gated settings action (threads-web.ts).
 *   Its state is random, stored only as a hash, bound to the signed-in session
 *   and a __Host- browser cookie, single use and short-lived.
 * - The long-lived (60-day) token is encrypted at rest with AES-GCM under a key
 *   derived by HKDF from COOKIE_SECRET, with its own context string, and is
 *   never shown, logged or returned.
 * - Renewal runs from cron under a lease, at least a day after issue and well
 *   before expiry, as Threads requires.
 * - Meta's uninstall and delete callbacks are verified with the app secret
 *   (signed_request) and fail closed: even a replay may suspend the current
 *   authorization, which requires owner PIN-gated reconnection.
 */
import type { Env } from "./env.ts";
import { ensureSchema } from "./db.ts";
import { esc, html, page } from "./html.ts";
import type { Session } from "./session.ts";
import { cookie, getCookie, randomToken, safeEqual, sha256 } from "./session.ts";

export const THREADS_STATE_COOKIE = "__Host-gsp_threads_state";
export const THREADS_SCOPES = ["threads_basic", "threads_content_publish"] as const;
export const THREADS_GRAPH = "https://graph.threads.net";
const STATE_TTL = 600;
/** Renew when less than this is left, but only once the token is a day old. */
const RENEW_BEFORE = 14 * 86400;
const RENEW_MIN_AGE = 86400;
const enc = new TextEncoder(), dec = new TextDecoder();
const AAD = enc.encode("gs-poster/threads/v1");
const unix = () => Math.floor(Date.now() / 1000);
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0));

export interface ThreadsConnection {
  user_id: string;
  username: string;
  connected_by: string;
  expires_at: number;
  issued_at: number;
  /** When the owner signed in (unchanged by token renewal). */
  connected_at: number;
  /** A verified provider callback suspended local posting. Null means authorized. */
  suspended_at: number | null;
  suspended_kind: string | null;
  suspended_issued_at: number | null;
  updated_at: string;
}
interface Row extends ThreadsConnection { token_cipher: string; lease_id: string | null; lease_until: number | null }

export function threadsConfigured(env: Env): boolean {
  return !!(env.THREADS_APP_ID && /^[0-9]{5,30}$/.test(env.THREADS_APP_ID) && env.THREADS_APP_SECRET && env.COOKIE_SECRET);
}
function need(env: Env): { id: string; secret: string } {
  if (!threadsConfigured(env)) throw new Error("Threads needs the THREADS_APP_ID and THREADS_APP_SECRET Worker secrets.");
  return { id: env.THREADS_APP_ID!, secret: env.THREADS_APP_SECRET! };
}
export function threadsRedirect(env: Env): string {
  return (env.PUBLIC_ORIGIN || "https://gs-poster.goofyspook.workers.dev").replace(/\/$/, "") + "/threads/callback";
}

async function key(env: Env): Promise<CryptoKey> {
  if (!env.COOKIE_SECRET) throw new Error("COOKIE_SECRET is missing.");
  const base = await crypto.subtle.importKey("raw", enc.encode(env.COOKIE_SECRET), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("gs-poster"), info: enc.encode("threads-token-v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function sealThreadsToken(env: Env, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, await key(env), enc.encode(token));
  return "v1." + b64u(iv) + "." + b64u(new Uint8Array(c));
}
export async function unsealThreadsToken(env: Env, value: string): Promise<string> {
  const [v, iv, c] = value.split(".");
  if (v !== "v1" || !iv || !c) throw new Error("Invalid stored Threads token.");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) as BufferSource, additionalData: AAD },
    await key(env), unb64u(c) as BufferSource);
  return dec.decode(plain);
}

export async function ensureThreadsSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS threads_oauth_states (state_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, actor TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS threads_accounts (account_key TEXT PRIMARY KEY CHECK(account_key='primary'),
      user_id TEXT NOT NULL, username TEXT NOT NULL, token_cipher TEXT NOT NULL, connected_by TEXT NOT NULL,
      expires_at INTEGER NOT NULL, issued_at INTEGER NOT NULL, updated_at TEXT NOT NULL, lease_id TEXT, lease_until INTEGER,
      connected_at INTEGER NOT NULL, suspended_at INTEGER, suspended_kind TEXT, suspended_issued_at INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS threads_revocation_events (
      event_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
      issued_at INTEGER NOT NULL, received_at INTEGER NOT NULL)`),
    // No account ID or encrypted token is retained in deletion receipts.
    db.prepare(`CREATE TABLE IF NOT EXISTS threads_deletion_requests (
      request_hash TEXT PRIMARY KEY, confirmation_code TEXT NOT NULL UNIQUE,
      received_at INTEGER NOT NULL, completed_at INTEGER NOT NULL)`),
  ]);
  // Keep consumed authorization states until the callback has committed.
  // Data deletion removes even consumed states, thereby fencing a callback
  // which is already waiting on the provider's token/profile endpoints.
  const stateCols = await db.prepare("PRAGMA table_info(threads_oauth_states)").all<{ name: string }>();
  if (!stateCols.results.some(column => column.name === "consumed_at")) {
    try { await db.prepare("ALTER TABLE threads_oauth_states ADD COLUMN consumed_at INTEGER").run(); }
    catch (error) { if (!/duplicate column name/i.test(String(error))) throw error; }
  }
  // Upgrade existing D1 accounts without dropping encrypted sign-ins.
  const columns = await db.prepare("PRAGMA table_info(threads_accounts)").all<{ name: string }>();
  for (const [name, type] of [["suspended_at", "INTEGER"], ["suspended_kind", "TEXT"], ["suspended_issued_at", "INTEGER"]]) {
    if (!columns.results.some(column => column.name === name)) {
      try { await db.prepare("ALTER TABLE threads_accounts ADD COLUMN " + name + " " + type).run(); }
      catch (error) { if (!/duplicate column name/i.test(String(error))) throw error; }
    }
  }
}

export async function threadsConnection(db: D1Database): Promise<ThreadsConnection | null> {
  await ensureThreadsSchema(db);
  return await db.prepare("SELECT user_id, username, connected_by, expires_at, issued_at, connected_at, suspended_at, suspended_kind, suspended_issued_at, updated_at FROM threads_accounts WHERE account_key = 'primary'")
    .first<ThreadsConnection>() ?? null;
}

/** Only call after the PIN check. Returns the Threads sign-in URL and the state for the browser cookie. */
export async function beginThreadsConnection(env: Env, session: Session): Promise<{ url: string; state: string }> {
  const app = need(env);
  await ensureThreadsSchema(env.DB);
  const state = randomToken();
  await env.DB.prepare("DELETE FROM threads_oauth_states WHERE expires_at <= ?").bind(unix()).run();
  await env.DB.prepare("INSERT INTO threads_oauth_states (state_hash, session_hash, actor, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(state), await sha256(session.raw), session.login, unix() + STATE_TTL).run();
  const url = new URL("https://threads.net/oauth/authorize");
  url.searchParams.set("client_id", app.id);
  url.searchParams.set("redirect_uri", threadsRedirect(env));
  url.searchParams.set("scope", THREADS_SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok || body.error) {
    const e = (body.error ?? {}) as { message?: string };
    // The upstream message names the problem; it never contains our secrets.
    throw new Error(`${what} failed${e.message ? ": " + String(e.message).slice(0, 200) : " (HTTP " + res.status + ")"}.`);
  }
  return body;
}

/** Callback: one-use state, same session, then code to long-lived token. */
export async function finishThreadsConnection(env: Env, session: Session, req: Request): Promise<ThreadsConnection> {
  const app = need(env);
  const u = new URL(req.url);
  const state = u.searchParams.get("state") || "", bound = getCookie(req, THREADS_STATE_COOKIE) || "";
  if (!state || !bound || !safeEqual(state, bound)) throw new Error("Threads sign-in expired or was opened in a different browser.");
  await ensureThreadsSchema(env.DB);
  const stateHash = await sha256(state);
  const consumedAt = unix();
  const consumed = await env.DB.prepare(`UPDATE threads_oauth_states SET consumed_at = ?
    WHERE state_hash = ? AND session_hash = ? AND actor = ? AND expires_at > ? AND consumed_at IS NULL`)
    .bind(consumedAt, stateHash, await sha256(session.raw), session.login, consumedAt).run();
  if (consumed.meta.changes !== 1) throw new Error("Threads sign-in expired or was already used. Start again from the settings page.");
  if (u.searchParams.has("error")) throw new Error("Threads sign-in was cancelled.");
  const code = (u.searchParams.get("code") || "").replace(/#_$/, "");
  if (!code || code.length > 2048) throw new Error("Threads did not return a sign-in code.");
  const short = await json(await fetch(THREADS_GRAPH + "/oauth/access_token", { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: app.id, client_secret: app.secret, grant_type: "authorization_code",
      redirect_uri: threadsRedirect(env), code }) }), "Threads sign-in");
  if (typeof short.access_token !== "string") throw new Error("Threads returned no access token.");
  const long = await json(await fetch(THREADS_GRAPH + "/access_token?" + new URLSearchParams({ grant_type: "th_exchange_token",
    client_secret: app.secret, access_token: short.access_token }), { redirect: "manual" }), "Threads long-lived token");
  if (typeof long.access_token !== "string" || typeof long.expires_in !== "number") throw new Error("Threads returned no long-lived token.");
  const me = await json(await fetch(THREADS_GRAPH + "/v1.0/me?" + new URLSearchParams({ fields: "id,username", access_token: long.access_token }),
    { redirect: "manual" }), "Threads profile");
  if (typeof me.id !== "string" || !/^[0-9]{5,30}$/.test(me.id)) throw new Error("Threads returned no account id.");
  const existing = await threadsConnection(env.DB);
  if (existing && existing.user_id !== me.id) throw new Error("Another Threads account is connected. Disconnect it first.");
  const now = unix();
  const saved = await env.DB.prepare(`INSERT INTO threads_accounts (account_key, user_id, username, token_cipher, connected_by, expires_at, issued_at, updated_at, connected_at)
    SELECT 'primary', ?, ?, ?, ?, ?, ?, ?, unixepoch() FROM threads_oauth_states
      WHERE state_hash = ? AND consumed_at = ? AND expires_at > unixepoch()
    ON CONFLICT(account_key) DO UPDATE SET username = excluded.username, token_cipher = excluded.token_cipher,
      connected_by = excluded.connected_by, expires_at = excluded.expires_at, issued_at = excluded.issued_at,
      updated_at = excluded.updated_at, connected_at = excluded.connected_at, suspended_at = NULL,
      suspended_kind = NULL, suspended_issued_at = NULL, lease_id = NULL, lease_until = NULL
    WHERE threads_accounts.user_id = excluded.user_id`)
    .bind(me.id, String(me.username ?? ""), await sealThreadsToken(env, long.access_token), session.login,
      now + long.expires_in, now, new Date().toISOString(), stateHash, consumedAt).run();
  // Deletion invalidates pending sign-ins atomically with erasure. If that
  // happened mid-exchange, the guarded insert cannot restore credentials.
  await env.DB.prepare("DELETE FROM threads_oauth_states WHERE state_hash = ? AND consumed_at = ?")
    .bind(stateHash, consumedAt).run();
  const connection = await threadsConnection(env.DB);
  if (saved.meta.changes !== 1 || connection?.user_id !== me.id)
    throw new Error("The Threads connection changed while signing in. Reload settings.");
  return connection;
}

/** The decrypted token for one Graph call. Never returned to a page or tool. */
export async function threadsAccessToken(env: Env): Promise<{ token: string; userId: string }> {
  await ensureThreadsSchema(env.DB);
  const row = await env.DB.prepare("SELECT * FROM threads_accounts WHERE account_key = 'primary'").first<Row>();
  if (!row) throw new Error("No Threads account is connected.");
  if (row.suspended_at != null) throw new Error("Threads posting is suspended by a signed account callback. Disconnect and reconnect in Threads settings using your approval PIN.");
  if (row.expires_at <= unix() + 60) throw new Error("The Threads sign-in has expired. Connect Threads again in settings.");
  return { token: await unsealThreadsToken(env, row.token_cipher), userId: row.user_id };
}

/** Cron: renew the 60-day token under a lease once it is old enough and getting close to expiry. */
export async function renewThreadsToken(env: Env, now = unix()): Promise<"renewed" | "not-needed" | "busy"> {
  if (!threadsConfigured(env)) return "not-needed";
  await ensureThreadsSchema(env.DB);
  const row = await env.DB.prepare("SELECT * FROM threads_accounts WHERE account_key = 'primary'").first<Row>();
  if (!row || row.suspended_at != null || row.expires_at - now > RENEW_BEFORE || now - row.issued_at < RENEW_MIN_AGE || row.expires_at <= now) return "not-needed";
  const lease = randomToken();
  const claim = await env.DB.prepare(`UPDATE threads_accounts SET lease_id = ?, lease_until = ?
    WHERE account_key = 'primary' AND suspended_at IS NULL AND token_cipher = ? AND (lease_until IS NULL OR lease_until < ?)`)
    .bind(lease, now + 60, row.token_cipher, now).run();
  if (claim.meta.changes !== 1) return "busy";
  try {
    const old = await unsealThreadsToken(env, row.token_cipher);
    const next = await json(await fetch(THREADS_GRAPH + "/refresh_access_token?" + new URLSearchParams({
      grant_type: "th_refresh_token", access_token: old }), { redirect: "manual" }), "Threads token renewal");
    if (typeof next.access_token !== "string" || typeof next.expires_in !== "number") throw new Error("Threads returned no renewed token.");
    await env.DB.prepare(`UPDATE threads_accounts SET token_cipher = ?, expires_at = ?, issued_at = ?, updated_at = ?, lease_id = NULL, lease_until = NULL
      WHERE account_key = 'primary' AND suspended_at IS NULL AND lease_id = ? AND user_id = ?`)
      .bind(await sealThreadsToken(env, next.access_token), now + next.expires_in, now, new Date().toISOString(), lease, row.user_id).run();
    return "renewed";
  } finally {
    await env.DB.prepare("UPDATE threads_accounts SET lease_id = NULL, lease_until = NULL WHERE account_key = 'primary' AND lease_id = ?")
      .bind(lease).run().catch(() => undefined);
  }
}

/** Removes the stored token. Threads offers no revoke call; Meta's own app settings revoke access. */
export async function disconnectThreads(db: D1Database): Promise<boolean> {
  await ensureThreadsSchema(db);
  const res = await db.prepare("DELETE FROM threads_accounts WHERE account_key = 'primary'").run();
  return (res.meta.changes ?? 0) > 0;
}

/** Verify Meta's signed_request with the app secret. Returns the payload or null. */
export async function verifySignedRequest(env: Env, signed: string): Promise<{ user_id?: string; issued_at?: number } | null> {
  if (!threadsConfigured(env)) return null;
  const [sig, payload] = signed.split(".");
  if (!sig || !payload || signed.length > 4096) return null;
  const hmac = await crypto.subtle.importKey("raw", enc.encode(env.THREADS_APP_SECRET!), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", hmac, unb64u(sig) as BufferSource, enc.encode(payload)); } catch { return null; }
  if (!ok) return null;
  try {
    const data = JSON.parse(dec.decode(unb64u(payload)));
    return data?.algorithm === "HMAC-SHA256" ? data : null;
  } catch { return null; }
}

/**
 * Public POST /threads/deauthorize and /threads/delete. A valid, fresh signed
 * event for the connected account suspends posting, including when it might
 * have come from an earlier authorization. The provider does not supply a
 * connection generation, so time-only replay filtering cannot be safe.
 *
 * The connection's suspension fields are a durable reconciliation marker;
 * the separately stored event digest also records signed callback history.
 * Reconnect requires the owner to PIN-disconnect and authorize again.
 */
export async function threadsAccountCallback(req: Request, env: Env, kind: "deauthorize" | "delete"): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "POST" } });
  // Never trust Content-Length: bound the actual bytes before parsing.
  const body = await readBounded(req, CALLBACK_MAX_BYTES);
  if (body === null) return new Response("Too large", { status: 413, headers });
  const signed = new URLSearchParams(body).get("signed_request") ?? "";
  const data = await verifySignedRequest(env, signed);
  if (!data?.user_id) return new Response("Invalid signed request", { status: 400, headers });
  const now = unix();
  const issued = data.issued_at;
  if (typeof issued !== "number" || !Number.isSafeInteger(issued) ||
      issued < now - CALLBACK_MAX_AGE || issued > now + CALLBACK_SKEW)
    return new Response("Stale signed request", { status: 400, headers });
  await ensureThreadsSchema(env.DB);
  const userId = String(data.user_id);

  if (kind === "delete") {
    // A data deletion request is not a deauthorization. Erase synchronously
    // and only return a completed receipt once the D1 transaction commits.
    // A signed replay re-runs erasure, also fencing a fresh connection to the
    // same account; it reuses its original anonymous status receipt.
    await ensureSchema(env.DB);
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS threads_media_grants (
      token_hash TEXT PRIMARY KEY, post_id TEXT NOT NULL, item_index INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, generation TEXT)`).run();
    const requestHash = await sha256("threads-delete-v1:" + signed);
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO threads_deletion_requests
        (request_hash, confirmation_code, received_at, completed_at)
        VALUES (?, ?, ?, ?)`).bind(requestHash, randomToken(), now, now),
      env.DB.prepare(`DELETE FROM threads_media_grants WHERE post_id IN
        (SELECT post_id FROM threads_jobs WHERE account_id = ?)`).bind(userId),
      // Preserve operational events, but remove provider names, identifiers
      // and remote errors from audit text for this deleted account.
      env.DB.prepare(`UPDATE audit SET detail = NULL WHERE
        (post_id IN (SELECT post_id FROM threads_jobs WHERE account_id = ?) AND action LIKE 'threads-%')
        OR action IN ('threads-account-connected', 'threads-account-suspended', 'threads-renewal-failed')`).bind(userId),
      // An irreversible final send may have completed. Surface uncertainty,
      // but rotate the generation to reject any late in-flight database write.
      // User-authored draft text and dates are not imported Meta profile data.
      env.DB.prepare(`UPDATE threads_jobs SET
        status = CASE WHEN status = 'sending' OR (status = 'failed' AND ambiguous = 1)
          THEN 'failed' WHEN status = 'published' THEN 'published' ELSE 'cancelled' END,
        ambiguous = CASE WHEN status = 'sending' OR (status = 'failed' AND ambiguous = 1)
          THEN 1 ELSE 0 END,
        error = CASE WHEN status = 'sending' OR (status = 'failed' AND ambiguous = 1)
          THEN 'Account deletion occurred after the final send began. Publication may have completed; never resend automatically.'
          ELSE NULL END,
        account_id = '', account_username = '', children = '[]', container_id = NULL,
        processing_since = NULL, media_id = NULL, permalink = NULL,
        lease_until = NULL, generation = lower(hex(randomblob(16))), updated_at = ?
        WHERE account_id = ?`).bind(new Date().toISOString(), userId),
      env.DB.prepare("DELETE FROM threads_revocation_events WHERE user_id = ?").bind(userId),
      // Do not let an earlier PIN-initiated OAuth state finish after deletion.
      env.DB.prepare("DELETE FROM threads_oauth_states"),
      env.DB.prepare("DELETE FROM threads_accounts WHERE account_key = 'primary' AND user_id = ?").bind(userId),
    ]);
    const receipt = await env.DB.prepare(`SELECT confirmation_code FROM threads_deletion_requests
      WHERE request_hash = ?`).bind(requestHash).first<{ confirmation_code: string }>();
    if (!receipt) throw new Error("Threads deletion was not durably acknowledged.");
    const origin = (env.PUBLIC_ORIGIN || "https://gs-poster.goofyspook.workers.dev").replace(/\/$/, "");
    return Response.json({
      url: origin + "/threads/delete/status/" + receipt.confirmation_code,
      confirmation_code: receipt.confirmation_code,
    }, { headers });
  }
  // A signed deauthorization may be a replay from a prior authorization.
  // Suspend the currently connected account rather than silently allowing
  // publication. The event digest and hold commit together.
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO threads_revocation_events (event_hash, user_id, kind, issued_at, received_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS
        (SELECT 1 FROM threads_accounts WHERE account_key = 'primary' AND user_id = ?)`)
      .bind(await sha256(kind + ":" + signed), userId, kind, issued, now, userId),
    env.DB.prepare(`UPDATE threads_accounts SET suspended_at = ?, suspended_kind = ?, suspended_issued_at = ?,
      lease_id = NULL, lease_until = NULL
      WHERE account_key = 'primary' AND user_id = ? AND suspended_at IS NULL`).bind(now, kind, issued, userId),
  ]);
  if ((results[1].meta.changes ?? 0) === 1) {
    // A simultaneous deletion may erase the connection after the suspension
    // transaction but before this audit write. Never restore account metadata.
    await ensureSchema(env.DB);
    await env.DB.prepare(`INSERT INTO audit (ts, actor, action, post_id, detail)
      SELECT ?, 'threads-provider', 'threads-account-suspended', NULL, ?
      WHERE EXISTS (SELECT 1 FROM threads_accounts WHERE account_key = 'primary'
        AND user_id = ? AND suspended_at IS NOT NULL)`)
      .bind(new Date().toISOString(), kind + " for account " + userId + " issued_at=" + issued,
        userId).run().catch(() => undefined);
  }
  return new Response("ok", { headers });
}

/** A public, unguessable receipt, without personal identifiers. */
export async function threadsDeletionStatus(req: Request, env: Env): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  if (req.method !== "GET" && req.method !== "HEAD")
    return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
  const match = /^\/threads\/delete\/status\/([A-Za-z0-9_-]{32})$/.exec(new URL(req.url).pathname);
  if (!match) return new Response("Not found", { status: 404, headers });
  await ensureThreadsSchema(env.DB);
  const row = await env.DB.prepare(`SELECT confirmation_code, completed_at FROM threads_deletion_requests
    WHERE confirmation_code = ?`).bind(match[1]).first<{ confirmation_code: string; completed_at: number }>();
  if (!row) return new Response("Not found", { status: 404, headers });
  const body = `<main><h2>Threads data deletion completed</h2>
    <p>GS Poster completed this request on ${esc(new Date(row.completed_at * 1000).toISOString())}.
    Stored Threads credentials, account profile and provider-issued job identifiers were erased.
    A publication already past the final send boundary may have completed and is never automatically retried.</p>
    <p>Confirmation code: <code>${esc(row.confirmation_code)}</code></p>
    <p>Editorial drafts and operational history without the deleted account details may remain.
    Content delivered to Meta is governed by its own retention rules.</p>
    <p><a href="/privacy">Privacy Policy</a></p></main>`;
  const response = html(page("Threads deletion status", body, { public: true }), { headers });
  // The HTML helper also adds cache directives. Normalize this sensitive
  // request-specific page to exactly one non-cacheable response directive.
  response.headers.set("Cache-Control", "no-store");
  return req.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

const CALLBACK_MAX_BYTES = 8192;
/** How old a Meta signed request may be (Meta sends them right away). */
const CALLBACK_MAX_AGE = 86400;
/** Allowed clock difference between Meta and the Worker. */
const CALLBACK_SKEW = 300;

/** The request body as text, or null if it is larger than `max` bytes. Never reads past `max`. */
async function readBounded(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") || 0) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel().catch(() => undefined); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

export function threadsStateCookie(state: string): string { return cookie(THREADS_STATE_COOKIE, state, STATE_TTL); }
export function clearThreadsStateCookie(): string { return cookie(THREADS_STATE_COOKIE, "", 0); }
