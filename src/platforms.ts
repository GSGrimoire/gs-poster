/**
 * One place for what each platform accepts, so the editor's live checks and
 * the server's save and approval checks agree. Hard limits block; display
 * guidance only warns. Display guidance describes how a feed tends to show a
 * picture; it is not a provider acceptance range and never blocks a save.
 *
 * Adding a platform (Instagram is next, see the 1 November review) means a
 * new entry here plus its adapter. Do not add Instagram here before its
 * placements and media hosting have been decided and reviewed.
 */
import { BSKY_IMAGE_COUNT, BSKY_TEXT_LIMIT } from "./bluesky.ts";
import { MAX_IMAGES } from "./validate.ts";

export type PlatformId = "facebook" | "bluesky" | "tiktok";

export interface AspectGuide {
  /** Width / height bounds a single photo shows uncropped in the feed. */
  min: number;
  max: number;
  /** Shown to the editor, e.g. "1:1 to 4:5". */
  label: string;
  /** What happens outside the bounds, in plain words. */
  outside: string;
}

export interface PlatformRules {
  id: PlatformId;
  label: string;
  /** Caption limits by format. */
  caption: { photo: number; video: number; text: number };
  /** Bluesky counts grapheme clusters; others count UTF-16 code units. */
  graphemes: boolean;
  maxPhotos: number;
  /** A text-only post is allowed. */
  textOnly: boolean;
  /** Photos and a video in one post. False everywhere today. */
  mixPhotoVideo: boolean;
  /** Every photo and video needs a description. */
  altRequired: boolean;
  aspect: AspectGuide;
  /** One line describing how the platform delivers the post. */
  delivery: string;
}

export const TIKTOK_PHOTO_MAX = 35;
export const TIKTOK_CAPTION_VIDEO = 2200;
export const TIKTOK_CAPTION_PHOTO = 4000;
export const FACEBOOK_CAPTION_MAX = 63_206;

export const PLATFORMS: Record<PlatformId, PlatformRules> = {
  facebook: {
    id: "facebook", label: "Facebook",
    caption: { photo: FACEBOOK_CAPTION_MAX, video: FACEBOOK_CAPTION_MAX, text: FACEBOOK_CAPTION_MAX },
    graphemes: false, maxPhotos: MAX_IMAGES, textOnly: true, mixPhotoVideo: false, altRequired: false,
    aspect: { min: 0.8, max: 1.91, label: "4:5 to 1.91:1",
      outside: "Facebook crops taller or wider photos in the feed. Several photos show as a cropped collage." },
    delivery: "Posts or schedules on the Page when you approve.",
  },
  bluesky: {
    id: "bluesky", label: "Bluesky",
    caption: { photo: BSKY_TEXT_LIMIT, video: BSKY_TEXT_LIMIT, text: BSKY_TEXT_LIMIT },
    graphemes: true, maxPhotos: BSKY_IMAGE_COUNT, textOnly: true, mixPhotoVideo: false, altRequired: true,
    aspect: { min: 0.5, max: 2, label: "1:2 to 2:1",
      outside: "Bluesky letterboxes extreme shapes. Two to four photos show as a cropped grid." },
    delivery: "Posts when you approve, or at the scheduled time.",
  },
  tiktok: {
    id: "tiktok", label: "TikTok",
    caption: { photo: TIKTOK_CAPTION_PHOTO, video: TIKTOK_CAPTION_VIDEO, text: 0 },
    graphemes: false, maxPhotos: TIKTOK_PHOTO_MAX, textOnly: false, mixPhotoVideo: false, altRequired: false,
    aspect: { min: 0.5, max: 0.6, label: "9:16",
      outside: "TikTok shows other shapes full width with bars above and below." },
    delivery: "Sent to your TikTok inbox. You add sound and post in the app.",
  },
};

export const PLATFORM_ORDER: PlatformId[] = ["facebook", "bluesky", "tiktok"];

/** Which caption limit applies for the media a target carries. */
export function captionLimit(id: PlatformId, media: { photos: number; video: boolean }): number {
  const r = PLATFORMS[id].caption;
  return media.video ? r.video : media.photos ? r.photo : r.text;
}

export interface TargetState {
  id: PlatformId;
  captionLength: number;
  photos: number;
  video: boolean;
  /** Descriptions missing, counted only when the platform requires them. */
  missingAlt: number;
  /** Width / height of each photo, when known. */
  ratios?: number[];
}

export interface TargetCheck { errors: string[]; warnings: string[] }

/**
 * Check one target against its rules. Pure, so the server and the browser
 * script (which receives PLATFORMS as JSON and mirrors this function) agree.
 */
export function checkTarget(t: TargetState): TargetCheck {
  const r = PLATFORMS[t.id];
  const errors: string[] = [], warnings: string[] = [];
  const limit = captionLimit(t.id, t);
  if (t.photos && t.video && !r.mixPhotoVideo) errors.push("Photos and a video cannot go in the same post.");
  if (t.photos > r.maxPhotos) errors.push(`${t.photos} photos; ${r.label} allows ${r.maxPhotos}.`);
  if (!t.photos && !t.video && !r.textOnly) errors.push(`${r.label} needs photos or a video.`);
  if (limit && t.captionLength > limit) errors.push(`Caption is ${t.captionLength} characters; ${r.label} allows ${limit}.`);
  if (r.altRequired && t.missingAlt) errors.push(`${t.missingAlt} ${t.missingAlt === 1 ? "description is" : "descriptions are"} missing.`);
  if (!t.captionLength && t.id !== "tiktok") warnings.push("Caption is empty.");
  const off = (t.ratios ?? []).filter((x) => x < r.aspect.min - 0.01 || x > r.aspect.max + 0.01).length;
  if (off) warnings.push(`${off} ${off === 1 ? "photo is" : "photos are"} outside ${r.aspect.label}. ${r.aspect.outside}`);
  return { errors, warnings };
}

/** Rules as JSON for the browser, safe inside an HTML attribute after esc(). */
export function platformRulesJson(): string {
  return JSON.stringify(PLATFORMS);
}
