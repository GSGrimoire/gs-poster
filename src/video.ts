/**
 * Initial Bluesky video transport: GitHub-hosted MP4 up to 20 MB.
 * The limit is intentionally much lower than Bluesky's 300 MB maximum.
 * Larger files require a separate streaming/transcoding workflow.
 */
import type { Env } from "./env.ts";
import { parseGitHubUrl } from "./media.ts";

export const INITIAL_VIDEO_MAX_BYTES = 20_000_000;

export function checkVideoUrl(value: string): string | null {
  const ref = parseGitHubUrl(value);
  if (!ref || !ref.path.toLowerCase().endsWith(".mp4")) {
    return "Bluesky video currently requires a GitHub MP4 file URL.";
  }
  return null;
}

export async function fetchVideo(env: Env, value: string): Promise<Uint8Array> {
  const bad = checkVideoUrl(value);
  if (bad) throw new Error(bad);
  const ref = parseGitHubUrl(value)!;
  const path = ref.path.split("/").map(encodeURIComponent).join("/");
  let response = await fetch(
    "https://raw.githubusercontent.com/" + ref.owner + "/" + ref.repo + "/" +
      encodeURIComponent(ref.ref) + "/" + path,
    { headers: { "User-Agent": "gs-poster" } },
  );
  if (!response.ok && env.GITHUB_READ_TOKEN) {
    response = await fetch("https://api.github.com/repos/" + ref.owner + "/" + ref.repo +
      "/contents/" + path + "?ref=" + encodeURIComponent(ref.ref), {
      headers: { Authorization: "Bearer " + env.GITHUB_READ_TOKEN,
        Accept: "application/vnd.github.raw+json", "User-Agent": "gs-poster" },
    });
  }
  if (!response.ok || !response.body) throw new Error("Could not fetch Bluesky MP4 video from the GitHub library.");
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > INITIAL_VIDEO_MAX_BYTES) {
    await response.body.cancel();
    throw new Error("MP4 exceeds the initial 20 MB Bluesky video upload limit.");
  }
  const parts: Uint8Array[] = [];
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > INITIAL_VIDEO_MAX_BYTES) {
        await reader.cancel();
        throw new Error("MP4 exceeds the initial 20 MB Bluesky video upload limit.");
      }
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  // A Git LFS pointer is text, not video. Reject it before trying the API.
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") {
    throw new Error("GitHub returned a non-MP4 file (possibly a Git LFS pointer).");
  }
  return bytes;
}
