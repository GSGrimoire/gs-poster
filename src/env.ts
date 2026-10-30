import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * Everything the Worker can see. Secrets are optional in the type because the
 * server must still start (and explain what is missing) before Gus has added them.
 */
export interface Env {
  OAUTH_KV: KVNamespace;
  DB: D1Database;
  /** Optional private object storage for draft uploads. */
  UPLOADS?: R2Bucket;
  /** Injected by OAuthProvider into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;

  // vars (wrangler.jsonc)
  ALLOWED_GITHUB_LOGINS: string;
  GRAPH_VERSION: string;
  TIMEZONE: string;
  /** Local tests only (must be http://127.0.0.1:...). */
  GRAPH_BASE_URL?: string;
  /** Optional: pin the public origin, e.g. https://gs-poster.example.workers.dev */
  PUBLIC_ORIGIN?: string;

  // secrets (Cloudflare dashboard → Worker → Settings → Variables and Secrets)
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Created automatically by the deploy workflow. Signs the web session cookie. */
  COOKIE_SECRET?: string;
  /** Typed on the approval page. Only Gus knows it. */
  APPROVE_PIN?: string;
  FB_PAGE_ID?: string;
  FB_PAGE_TOKEN?: string;
  /** Optional: when the Meta app has "Require app secret" on. */
  FB_APP_SECRET?: string;
  /** Bluesky service credentials, only kept in Cloudflare Worker secrets. */
  BSKY_HANDLE?: string;
  BSKY_APP_PASSWORD?: string;
  /** Cloudflare Images binding used to strip metadata and shrink uploads. */
  IMAGES?: ImagesBinding;
  /** Optional: read-only GitHub token for images in private repos. */
  GITHUB_READ_TOKEN?: string;
  /** Exact private owner/repo allowed for temporary binary GitHub blob intake. */
  GITHUB_STAGING_REPO?: string;
  /** TikTok developer Login Kit client key (Worker secret). */
  TIKTOK_CLIENT_KEY?: string;
  /** TikTok developer Login Kit client secret (Worker secret). */
  TIKTOK_CLIENT_SECRET?: string;
  /** Separate high-entropy key for encrypting TikTok tokens at rest (Worker secret, 32+ characters). */
  TIKTOK_TOKEN_ENCRYPTION_KEY?: string;
  /** Exact callback registered with TikTok. Defaults to the production workers.dev URL. */
  TIKTOK_REDIRECT_URI?: string;
}

export const REQUIRED_SECRETS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "COOKIE_SECRET",
  "APPROVE_PIN",
  "FB_PAGE_ID",
  "FB_PAGE_TOKEN",
] as const;

export function missingSecrets(env: Env): string[] {
  return REQUIRED_SECRETS.filter((k) => !env[k]);
}

export function allowedLogins(env: Env): string[] {
  return (env.ALLOWED_GITHUB_LOGINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
