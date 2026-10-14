/**
 * Images come from GitHub: the image library (public raw URLs) or a private
 * repo (needs GITHUB_READ_TOKEN). Nothing else is fetched, so the server
 * cannot be pointed at arbitrary URLs.
 */
import type { Env } from "./env.ts";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
};

export interface GitHubRef {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

/** raw.githubusercontent.com/{o}/{r}/{ref|refs/heads/ref}/{path} or github.com/{o}/{r}/blob|raw/{ref}/{path} */
export function parseGitHubUrl(input: string): GitHubRef | null {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const seg = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (u.hostname === "raw.githubusercontent.com") {
    if (seg.length < 4) return null;
    const [owner, repo] = seg;
    if (seg[2] === "refs" && (seg[3] === "heads" || seg[3] === "tags") && seg.length >= 6) {
      return { owner, repo, ref: seg[4], path: seg.slice(5).join("/") };
    }
    return { owner, repo, ref: seg[2], path: seg.slice(3).join("/") };
  }
  if (u.hostname === "github.com") {
    if (seg.length < 5 || (seg[2] !== "blob" && seg[2] !== "raw")) return null;
    return { owner: seg[0], repo: seg[1], ref: seg[3], path: seg.slice(4).join("/") };
  }
  return null;
}

export function imageType(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ALLOWED_TYPES[ext] ?? null;
}

export function checkImageUrl(url: string): string | null {
  const ref = parseGitHubUrl(url);
  if (!ref) return `Not a GitHub file URL: ${url}. Use a raw.githubusercontent.com or github.com/.../blob/... link.`;
  if (!imageType(ref.path)) return `Unsupported image type: ${ref.path}. Use JPG, PNG or GIF.`;
  return null;
}

export interface ImageBytes {
  bytes: ArrayBuffer;
  type: string;
  name: string;
}

export async function fetchImage(env: Env, url: string): Promise<ImageBytes> {
  const ref = parseGitHubUrl(url);
  if (!ref) throw new Error(`Not a GitHub file URL: ${url}`);
  const type = imageType(ref.path);
  if (!type) throw new Error(`Unsupported image type: ${ref.path}`);
  const name = ref.path.split("/").pop() || "image";
  const encPath = ref.path.split("/").map(encodeURIComponent).join("/");

  // Public files: plain raw URL, no token involved.
  let res = await fetch(`https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${encodeURIComponent(ref.ref)}/${encPath}`, {
    headers: { "User-Agent": "gs-poster" },
  });
  // Private files: GitHub API with the read-only token.
  if (!res.ok && env.GITHUB_READ_TOKEN) {
    res = await fetch(
      `https://api.github.com/repos/${ref.owner}/${ref.repo}/contents/${encPath}?ref=${encodeURIComponent(ref.ref)}`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_READ_TOKEN}`,
          Accept: "application/vnd.github.raw+json",
          "User-Agent": "gs-poster",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
  }
  if (!res.ok) {
    const hint = env.GITHUB_READ_TOKEN ? "" : " If the repo is private, add the GITHUB_READ_TOKEN secret.";
    throw new Error(`Could not fetch ${ref.owner}/${ref.repo}/${ref.path} (HTTP ${res.status}).${hint}`);
  }
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_IMAGE_BYTES) throw new Error(`${name} is ${(len / 1048576).toFixed(1)} MB; the limit is 10 MB.`);
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`${name} is over 10 MB.`);
  return { bytes, type, name };
}
