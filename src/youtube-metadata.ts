/**
 * YouTube Free Song Sunday metadata foundation.
 *
 * This module is intentionally pure: it neither receives credentials nor
 * makes network requests, creates a job, or authorizes publication. The
 * future YouTube adapter must remain behind the existing owner/PIN approval
 * boundary and independently checkpoint every external side effect.
 */

import { checkMessage } from "./validate.ts";

export const YOUTUBE_TITLE_MAX_CHARACTERS = 100;
export const YOUTUBE_DESCRIPTION_MAX_BYTES = 5_000;
export const YOUTUBE_TAGS_MAX_CHARACTERS = 500;

export interface YouTubeMusicVideoDraft {
  /** Reviewed, audience-facing title, not an internal release label. */
  title: string;
  /** Reviewed description, including the approved Patreon destination. */
  description: string;
  /** The Free Song Sunday free/public Patreon post, not an arbitrary URL. */
  patreonPostUrl: string;
  /** Optional target playlist. This is not automatically added by this module. */
  playlistId?: string | null;
  tags?: string[];
  /** Deliberate audience declaration by the owner; never inferred. */
  madeForKids: boolean | null;
  /** Owner confirms they have rights to upload the audio and imagery. */
  rightsConfirmed: boolean;
  /** Explicit owner declaration when YouTube requires synthetic-media disclosure. */
  containsSyntheticMedia?: boolean | null;
}

export interface YouTubeMetadataCheck {
  errors: string[];
  warnings: string[];
}

export interface YouTubePrivateInsertBody {
  snippet: {
    title: string;
    description: string;
    categoryId: "10";
    tags?: string[];
  };
  status: {
    privacyStatus: "private";
    selfDeclaredMadeForKids: boolean;
    containsSyntheticMedia?: boolean;
  };
}

const encoder = new TextEncoder();
const videoIdPattern = /^[a-zA-Z0-9_-]{11}$/;
const forbiddenYouTubeText = /[<>]/;
const unsafeControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** Bidirectional overrides/isolates can make a displayed link differ from the real one. */
const bidiControl = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/** Unpaired UTF-16 surrogates are not valid Unicode text. */
const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** Invisible characters are allowed but worth a human look. */
const invisible = /[\u00ad\u200b-\u200d\u2060\ufeff]/;
const linkPattern = /https?:\/\/[^\s<>]+/gi;
/** Sentence punctuation that commonly follows a link and is not part of it. */
const trailingPunctuation = /[.,;:!?)\]}'"]+$/;

function unsupportedText(value: string): boolean {
  return forbiddenYouTubeText.test(value) || unsafeControl.test(value) ||
    bidiControl.test(value) || loneSurrogate.test(value);
}

/** Every http(s) link in the text, with trailing sentence punctuation removed. */
function descriptionLinks(text: string): string[] {
  return Array.from(text.matchAll(linkPattern), (m) => m[0].replace(trailingPunctuation, ""));
}

/** Only an HTTPS link to a Patreon post can satisfy the product call to action. */
export function validFreePatreonPostUrl(value: string): boolean {
  try {
    if (typeof value !== "string") return false;
    const url = new URL(value);
    // Require the canonical serialized form, so whitespace, tabs, newlines,
    // case variants or default ports that the URL parser silently drops
    // cannot make the reviewed string differ from the parsed destination.
    return url.href === value &&
      url.protocol === "https:" &&
      (url.hostname === "patreon.com" || url.hostname === "www.patreon.com") &&
      !url.username && !url.password && !url.port && !url.search && !url.hash &&
      /^\/posts\/[^/]+(?:\/)?$/.test(url.pathname);
  } catch { return false; }
}

/** Tag limits count punctuation and quotes around multiword tags. */
export function youtubeTagCharacters(tags: readonly string[]): number {
  return tags.reduce((count, tag, index) =>
    count + (index > 0 ? 1 : 0) + tag.length + (tag.includes(" ") ? 2 : 0), 0);
}

/** No API calls, storage writes, or side effects. */
export function validateYouTubeMusicVideoDraft(draft: YouTubeMusicVideoDraft): YouTubeMetadataCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Drafts will arrive as JSON from the editor or connector, so check the
  // runtime shape instead of trusting the TypeScript interface.
  const shapeErrors: string[] = [];
  if (typeof draft?.title !== "string") shapeErrors.push("YouTube title must be text.");
  if (typeof draft?.description !== "string") shapeErrors.push("YouTube description must be text.");
  if (typeof draft?.patreonPostUrl !== "string") shapeErrors.push("Patreon post URL must be text.");
  if (draft?.tags != null && (!Array.isArray(draft.tags) || draft.tags.some((tag) => typeof tag !== "string")))
    shapeErrors.push("YouTube tags must be a list of text values.");
  if (draft?.playlistId != null && typeof draft.playlistId !== "string")
    shapeErrors.push("YouTube playlist identifier must be text.");
  if (shapeErrors.length) return { errors: shapeErrors, warnings };

  const title = draft.title.trim();
  const description = draft.description.trim();

  if (!title) errors.push("YouTube title is required.");
  if (Array.from(title).length > YOUTUBE_TITLE_MAX_CHARACTERS)
    errors.push(`YouTube title exceeds ${YOUTUBE_TITLE_MAX_CHARACTERS} characters.`);
  if (/[\t\r\n]/.test(title) || unsupportedText(title))
    errors.push("YouTube title contains unsupported characters.");

  if (!description) errors.push("YouTube description is required.");
  if (encoder.encode(description).byteLength > YOUTUBE_DESCRIPTION_MAX_BYTES)
    errors.push(`YouTube description exceeds ${YOUTUBE_DESCRIPTION_MAX_BYTES} UTF-8 bytes.`);
  if (unsupportedText(description))
    errors.push("YouTube description contains unsupported characters.");
  if (invisible.test(title) || invisible.test(description))
    warnings.push("Title or description contains invisible characters (zero-width or soft hyphen).");

  if (!validFreePatreonPostUrl(draft.patreonPostUrl)) {
    errors.push("Free Song Sunday needs a valid HTTPS Patreon /posts/ link.");
  } else {
    // Compare whole links, not substrings: ".../posts/x" must not be
    // satisfied by a different post such as ".../posts/xyz".
    const links = descriptionLinks(description);
    if (!links.includes(draft.patreonPostUrl))
      errors.push("YouTube description must include the reviewed Patreon post URL.");
    const firstLink = links[0];
    if (firstLink && firstLink !== draft.patreonPostUrl)
      warnings.push("The first description link is not the reviewed Patreon post.");
  }

  if (draft.playlistId != null && !/^[a-zA-Z0-9_-]{1,150}$/.test(draft.playlistId))
    errors.push("YouTube playlist identifier is invalid.");
  if (draft.madeForKids !== true && draft.madeForKids !== false)
    errors.push("YouTube audience selection must be explicit.");
  if (draft.rightsConfirmed !== true)
    errors.push("Confirm rights to upload the song and artwork before preparing an upload.");
  if (draft.containsSyntheticMedia != null && typeof draft.containsSyntheticMedia !== "boolean")
    errors.push("Synthetic-media disclosure must be explicitly true or false when provided.");

  const houseRules = checkMessage(`${title}\n${description}`, { hasImages: true });
  errors.push(...houseRules.errors);
  warnings.push(...houseRules.warnings);

  const tags = draft.tags ?? [];
  if (tags.some((tag) => !tag.trim() || tag !== tag.trim() || /[,"\t\r\n]/.test(tag) || unsupportedText(tag)))
    errors.push("YouTube tags must be nonempty, trimmed, and contain no commas, quotes or unsupported characters.");
  if (tags.length) {
    // Tags are public metadata too: the house rules (no tool names, prices,
    // retired tiers) apply to them as well as to the title and description.
    const tagRules = checkMessage(tags.join("\n"), { hasImages: true });
    errors.push(...tagRules.errors.map((e) => `Tags: ${e}`));
  }
  if (youtubeTagCharacters(tags) > YOUTUBE_TAGS_MAX_CHARACTERS)
    errors.push(`YouTube tags exceed ${YOUTUBE_TAGS_MAX_CHARACTERS} characters.`);
  if (tags.some((tag) => tag.length > 100)) warnings.push("Very long tags are unlikely to help discovery.");
  if (draft.containsSyntheticMedia == null)
    warnings.push("Review whether YouTube requires a synthetic-media disclosure for this video.");
  return { errors, warnings };
}

/**
 * Build the *private-only* outbound metadata for a later approved upload.
 * The future adapter must gate this behind owner approval and must not turn
 * private into public, unlisted, or scheduled without an explicit review.
 */
export function buildPrivateYouTubeMusicVideoMetadata(draft: YouTubeMusicVideoDraft): YouTubePrivateInsertBody {
  const check = validateYouTubeMusicVideoDraft(draft);
  if (check.errors.length) throw new Error(check.errors.join(" "));
  const snippet: YouTubePrivateInsertBody["snippet"] = {
    title: draft.title.trim(), description: draft.description.trim(), categoryId: "10",
  };
  if (draft.tags?.length) snippet.tags = [...draft.tags];
  const status: YouTubePrivateInsertBody["status"] = {
    privacyStatus: "private", selfDeclaredMadeForKids: draft.madeForKids as boolean,
  };
  if (typeof draft.containsSyntheticMedia === "boolean")
    status.containsSyntheticMedia = draft.containsSyntheticMedia;
  return { snippet, status };
}

/** Build a canonical owner-facing URL only from a validated YouTube video ID. */
export function youtubeStudioVideoUrl(videoId: string): string {
  if (!videoIdPattern.test(videoId)) throw new Error("Invalid YouTube video identifier.");
  return `https://studio.youtube.com/video/${videoId}/edit`;
}
