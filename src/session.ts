/**
 * Web session for the approval page: a signed cookie holding the GitHub login.
 * Only logins in ALLOWED_GITHUB_LOGINS ever get one.
 */
import { allowedLogins, type Env } from "./env.ts";

export const SESSION_COOKIE = "__Host-gsp_session";
export const LOGIN_STATE_COOKIE = "__Host-gsp_login";
const SESSION_DAYS = 30;

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): string {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return atob(pad);
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export async function makeSession(env: Env, login: string): Promise<string> {
  if (!env.COOKIE_SECRET) throw new Error("COOKIE_SECRET is missing");
  const payload = b64url(enc.encode(JSON.stringify({ login, exp: Date.now() + SESSION_DAYS * 86400_000 })));
  return `${payload}.${await hmac(env.COOKIE_SECRET, "session:" + payload)}`;
}

export function sessionCookie(value: string): string {
  return cookie(SESSION_COOKIE, value, SESSION_DAYS * 86400);
}

export interface Session {
  login: string;
  raw: string;
}

export async function readSession(env: Env, req: Request): Promise<Session | null> {
  const raw = getCookie(req, SESSION_COOKIE);
  if (!raw || !env.COOKIE_SECRET) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  if (!safeEqual(sig, await hmac(env.COOKIE_SECRET, "session:" + payload))) return null;
  try {
    const { login, exp } = JSON.parse(fromB64url(payload));
    if (typeof login !== "string" || typeof exp !== "number" || exp < Date.now()) return null;
    if (!allowedLogins(env).includes(login.toLowerCase())) return null;
    return { login, raw };
  } catch {
    return null;
  }
}

/** Per-session CSRF token for the approval forms. */
export function csrfToken(env: Env, session: Session): Promise<string> {
  return hmac(env.COOKIE_SECRET!, "csrf:" + session.raw);
}

export async function checkCsrf(env: Env, session: Session, token: string | null): Promise<boolean> {
  return !!token && safeEqual(token, await csrfToken(env, session));
}

export function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(24)));
}

export async function sha256(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
