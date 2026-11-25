import { esc } from "./html.ts";
import { parseUploadRef } from "./upload.ts";

/** An immutable key for an upload, never a way to select a draft image. */
export function imageVersion(source: string): string | null {
  const ref = parseUploadRef(source);
  return ref && ref.ext !== "mp4" ? ref.id + "." + ref.ext : null;
}

export function imagePreviewUrl(
  postId: string, index: number, source: string, platform: string | null, thumbnail = false,
): string {
  const params = [];
  if (thumbnail) params.push("thumb=1");
  if (platform) params.push("platform=" + encodeURIComponent(platform));
  const version = imageVersion(source);
  if (version) params.push("v=" + version);
  return `/media/${postId}/${index}` + (params.length ? "?" + params.join("&") : "");
}

export function linkedThumbnail(original: string, alt: string): string {
  const [path, query] = original.split("?");
  const thumbnail = path + "?thumb=1" + (query ? "&" + query : "");
  return `<a href="${esc(original)}" target="_blank" rel="noopener" draggable="false" aria-label="Open original: ${esc(alt)}"><img src="${esc(thumbnail)}" alt="${esc(alt)}" loading="lazy" draggable="false"></a>`;
}
