/**
 * PR #90 staging is a deliberately non-publishing Worker entry.
 * Only editor draft mutations and private media preparation are permitted.
 * This is defense in depth in addition to isolated D1, R2, KV and NO provider
 * credentials. Never use this entry with production bindings.
 */
export function pr90StagingAllowed(method:string,pathname:string):boolean {
  if (/^\/(?:mcp|token|register|authorize|revoke)(?:\/|$)/.test(pathname)) return false;
  if (method==="GET" || method==="HEAD") return true;
  if (method==="PUT") return /^\/upload\/[a-f0-9]{32}\/[A-Za-z0-9_-]{20,64}$/.test(pathname);
  if (method!=="POST") return false;
  if (pathname==="/new") return true; // Draft creation is not approval.
  return /^\/post\/p_[a-z0-9]+\/(?:save|return-to-drafts|upload-link|attach-image|video-link|attach-video|import-tiktok-image|import-video)$/.test(pathname);
}
