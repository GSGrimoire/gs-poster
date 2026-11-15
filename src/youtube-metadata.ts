/**
 * YouTube Free Song Sunday metadata foundation.
 *
 * This module is intentionally pure: it neither receives credentials nor
 * makes network requests, creates a job, or authorizes publication. The
 * future YouTube adapter must remain behind the existing owner/PIN approval
 * boundary and independently checkpoint every external side effect.
 */

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
const firstLinkPattern = /https?:\/\/[^\s<>]+/i;

/** Only an HTTPS link to a Patreon post can satisfy the product call to action. */
export function validFreePatreonPostUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "patreon.com" || url.hostname === "www.patreon.com") &&
      !url.username && !url.password &&
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
  const title = draft.title.trim();
  const description = draft.description.trim();

  if (!title) errors.push("YouTube title is required.");
  if (Array.from(title).length > YOUTUBE_TITLE_MAX_CHARACTERS)
    errors.push(`YouTube title exceeds ${YOUTUBE_TITLE_MAX_CHARACTERS} characters.`);
  if (/\r|\n/.test(title) || forbiddenYouTubeText.test(title) || unsafeControl.test(title))
    errors.push("YouTube title contains unsupported characters.");

  if (!description) errors.push("YouTube description is required.");
  if (encoder.encode(description).byteLength > YOUTUBE_DESCRIPTION_MAX_BYTES)
    errors.push(`YouTube description exceeds ${YOUTUBE_DESCRIPTION_MAX_BYTES} UTF-8 bytes.`);
  if (forbiddenYouTubeText.test(description) || unsafeControl.test(description))
    errors.push("YouTube description contains unsupported characters.");

  if (!validFreePatreonPostUrl(draft.patreonPostUrl)) {
    errors.push("Free Song Sunday needs a valid HTTPS Patreon /posts/ link.");
  } else {
    if (!description.includes(draft.patreonPostUrl))
      errors.push("YouTube description must include the reviewed Patreon post URL.");
    const firstLink = description.match(firstLinkPattern)?.[0];
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

  const tags = draft.tags ?? [];
  if (tags.some((tag) => !tag.trim() || tag !== tag.trim() || forbiddenYouTubeText.test(tag) || unsafeControl.test(tag)))
    errors.push("YouTube tags must be nonempty, trimmed, and contain supported characters.");
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
