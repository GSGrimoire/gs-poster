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
