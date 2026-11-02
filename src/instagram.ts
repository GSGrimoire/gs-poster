/**
 * Instagram feed target: preparation only. Nothing here sends anything to
 * Instagram. Each photo is fitted to one frame for the whole carousel by
 * either CROPPING (fill the frame, choose the part to keep) or PADDING (keep
 * the whole picture, fill the rest with a background colour).
 *
 * The original is never changed. The editor stores the frame and, per photo,
 * mode, focus point, zoom and background. The server renders the exact JPEG
 * from those numbers with the Cloudflare Images binding (renderInstagram); the
 * browser preview uses the same instagramPlan() function, so what the editor
 * shows is what the server renders.
 *
 * Meta Content Publishing API, feed images (checked 2 November 2026,
 * developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media):
 * JPEG, max 8 MB, aspect 4:5 to 1.91:1, width 320 to 1440 px, sRGB,
 * carousel up to 10 items, caption 2,200 characters, 30 hashtags, 20 @ tags.
 */

export const INSTAGRAM_FRAMES = ["4:5", "1:1", "1.91:1"] as const;
export type InstagramFrame = typeof INSTAGRAM_FRAMES[number];
export const INSTAGRAM_BACKGROUNDS = { dark: "#141110", black: "#000000", white: "#ffffff", parchment: "#f4eee3" } as const;
export type InstagramBackground = keyof typeof INSTAGRAM_BACKGROUNDS;
export const INSTAGRAM_MAX_ITEMS = 10;
export const INSTAGRAM_CAPTION_MAX = 2200;
export const INSTAGRAM_HASHTAG_MAX = 30;
export const INSTAGRAM_MENTION_MAX = 20;
export const INSTAGRAM_MAX_ZOOM = 4;

export interface InstagramItem {
  /** Must be media already on this post (Facebook, TikTok or Bluesky). */
  url: string;
  mode: "crop" | "pad";
  /** Focus point, 0 to 1 across and down the original. Crop only. */
  cx: number;
  cy: number;
  /** 1 fills the frame; up to 4 zooms further in. Crop only. */
  zoom: number;
  /** Fill colour around a padded photo. */
  bg: InstagramBackground;
}

export interface InstagramDraft {
  caption: string;
  frame: InstagramFrame;
  items: InstagramItem[];
}

export interface PlanRect { x: number; y: number; w: number; h: number }
export interface Plan { outW: number; outH: number; src: PlanRect; dst: PlanRect }

/**
 * Where a source picture goes in the Instagram frame. Self-contained (no
 * outside references) because its source text is also sent to the browser.
 */
export function instagramPlan(srcW: number, srcH: number, frame: string, mode: string, cx: number, cy: number, zoom: number): Plan {
  const sizes: Record<string, [number, number]> = { "4:5": [1080, 1350], "1:1": [1080, 1080], "1.91:1": [1080, 566] };
  const [outW, outH] = sizes[frame] || sizes["4:5"];
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  if (mode === "pad") {
    const s = Math.min(outW / srcW, outH / srcH);
    const w = Math.max(1, Math.round(srcW * s)), h = Math.max(1, Math.round(srcH * s));
    return { outW, outH, src: { x: 0, y: 0, w: srcW, h: srcH },
      dst: { x: Math.round((outW - w) / 2), y: Math.round((outH - h) / 2), w, h } };
  }
  const ratio = outW / outH;
  let w = srcW, h = srcW / ratio;
  if (h > srcH) { h = srcH; w = srcH * ratio; }
  const z = clamp(Number.isFinite(zoom) ? zoom : 1, 1, 4);
  w = Math.max(1, Math.round(w / z));
  h = Math.max(1, Math.round(h / z));
  const fx = clamp(Number.isFinite(cx) ? cx : 0.5, 0, 1), fy = clamp(Number.isFinite(cy) ? cy : 0.5, 0, 1);
  const x = Math.round(clamp(fx * srcW - w / 2, 0, srcW - w));
  const y = Math.round(clamp(fy * srcH - h / 2, 0, srcH - h));
  return { outW, outH, src: { x, y, w, h }, dst: { x: 0, y: 0, w: outW, h: outH } };
}

/** Browser copy of instagramPlan, from the same source. */
export const INSTAGRAM_PLAN_JS = "const instagramPlan = " + instagramPlan.toString() + ";";

export function countHashtags(text: string): number {
  return (text.match(/(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu) ?? []).length;
}
export function countMentions(text: string): number {
  return (text.match(/(^|[^\p{L}\p{N}_])@[A-Za-z0-9._]+/gu) ?? []).length;
}

/** Hard problems that stop a save. Showing them live is the editor's job. */
export function instagramSaveErrors(d: InstagramDraft, allowedUrls: Set<string>): string[] {
  const errors: string[] = [];
  if (!INSTAGRAM_FRAMES.includes(d.frame)) errors.push("Choose an Instagram frame: 4:5, 1:1 or 1.91:1.");
  if (d.items.length > INSTAGRAM_MAX_ITEMS) errors.push(`Instagram carousels hold at most ${INSTAGRAM_MAX_ITEMS} photos.`);
  if (d.caption.length > INSTAGRAM_CAPTION_MAX) errors.push(`The Instagram caption is ${d.caption.length} characters; Instagram allows ${INSTAGRAM_CAPTION_MAX}.`);
  if (countHashtags(d.caption) > INSTAGRAM_HASHTAG_MAX) errors.push(`Instagram allows at most ${INSTAGRAM_HASHTAG_MAX} hashtags.`);
  if (countMentions(d.caption) > INSTAGRAM_MENTION_MAX) errors.push(`Instagram allows at most ${INSTAGRAM_MENTION_MAX} @ tags.`);
  const seen = new Set<string>();
  for (const it of d.items) {
    if (!allowedUrls.has(it.url)) { errors.push("An Instagram photo is not one of this post's photos."); break; }
    if (seen.has(it.url)) { errors.push("The same photo is in the Instagram carousel twice."); break; }
    seen.add(it.url);
    if (it.mode !== "crop" && it.mode !== "pad") { errors.push("Each Instagram photo must be cropped or padded."); break; }
    if (!(it.bg in INSTAGRAM_BACKGROUNDS)) { errors.push("Unknown Instagram background colour."); break; }
    if (![it.cx, it.cy, it.zoom].every(Number.isFinite) || it.cx < 0 || it.cx > 1 || it.cy < 0 || it.cy > 1
      || it.zoom < 1 || it.zoom > INSTAGRAM_MAX_ZOOM) { errors.push("An Instagram crop position is out of range."); break; }
  }
  return errors;
}

/** Strict reader for the editor's JSON field. Anything unexpected is an error, never guessed. */
export function readInstagramItems(raw: string): InstagramItem[] | null {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(data) || data.length > 50) return null;
  const items: InstagramItem[] = [];
  for (const v of data) {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o.url !== "string" || o.url.length > 2048) return null;
    if (typeof o.mode !== "string" || typeof o.bg !== "string") return null;
    const num = (x: unknown, d: number) => (x === undefined ? d : typeof x === "number" && Number.isFinite(x) ? x : null);
    const cx = num(o.cx, 0.5), cy = num(o.cy, 0.5), zoom = num(o.zoom, 1);
    if (cx === null || cy === null || zoom === null) return null;
    items.push({ url: o.url, mode: o.mode as InstagramItem["mode"], cx, cy, zoom, bg: o.bg as InstagramBackground });
  }
  return items;
}

export function defaultItem(url: string, mode: InstagramItem["mode"] = "crop"): InstagramItem {
  return { url, mode, cx: 0.5, cy: 0.5, zoom: 1, bg: "dark" };
}

/**
 * Render one Instagram photo with the Cloudflare Images binding: trim to the
 * plan's source rectangle and resize to the frame (crop), or fit the whole
 * picture inside the frame on the background colour (pad). JPEG, sRGB,
 * no metadata. Returns the JPEG bytes; throws if the binding is missing.
 */
export async function renderInstagram(images: ImagesBinding, bytes: Uint8Array, frame: InstagramFrame, item: InstagramItem): Promise<Uint8Array> {
  const info = await images.info(new Blob([bytes]).stream());
  if (!("width" in info)) throw new Error("Vector images cannot be prepared for Instagram.");
  const plan = instagramPlan(info.width, info.height, frame, item.mode, item.cx, item.cy, item.zoom);
  const bg = INSTAGRAM_BACKGROUNDS[item.bg];
  let t = images.input(new Blob([bytes]).stream());
  if (item.mode === "crop") {
    // Cloudflare applies trim before resizing ("performed before resizing and
    // rotation", Images docs). Four explicit sides, in source pixels.
    t = t.transform({
      trim: { left: plan.src.x, top: plan.src.y,
        right: info.width - plan.src.x - plan.src.w, bottom: info.height - plan.src.y - plan.src.h },
      width: plan.outW, height: plan.outH, fit: "cover",
    });
  } else {
    t = t.transform({ width: plan.outW, height: plan.outH, fit: "pad", background: bg });
  }
  const out = await t.output({ format: "image/jpeg", quality: 90, background: bg, anim: false });
  return new Uint8Array(await out.response().arrayBuffer());
}
