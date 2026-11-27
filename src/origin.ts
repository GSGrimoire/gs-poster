/**
 * Is this POST from our own pages? Browsers send `Origin: null` on a form
 * POST when the page's Referrer-Policy is `no-referrer`, so "null" is accepted
 * only when Sec-Fetch-Site confirms the request came from this site.
 * The per-session CSRF token is checked separately.
 */
export function isSameOrigin(selfOrigin: string, origin: string | null, fetchSite: string | null): boolean {
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  if (origin === null) return true;
  if (origin === selfOrigin) return true;
  if (origin === "null") return fetchSite === "same-origin";
  return false;
}

/** Fixed, never-resolvable base used only to check that a path stays on our origin. */
const NEXT_BASE = "https://gs-poster.invalid";

/**
 * Where to send the browser after sign-in (issue #88). Only an origin-relative
 * path on GS Poster is accepted; anything else becomes "/". Raw backslashes and
 * control characters are refused before parsing, because browsers turn "\" into
 * "/" and drop tabs and newlines, so "/\evil.example" would leave the site.
 * The result is the path re-serialized from a fixed base, so it cannot carry a
 * scheme or a host.
 */
export function safeNext(next: string | null): string {
  if (!next || next.length > 2048) return "/";
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  let url: URL;
  try { url = new URL(next, NEXT_BASE); } catch { return "/"; }
  if (url.origin !== NEXT_BASE) return "/";
  const path = url.pathname + url.search + url.hash;
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}
