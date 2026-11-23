/** Private storage and transport ceilings are independent of provider limits. */
export const PRIVATE_VIDEO_MAX_BYTES = 300_000_000;
/** Single browser PUT stays below the Cloudflare inbound request body ceiling. */
export const SINGLE_REQUEST_VIDEO_MAX_BYTES = 50_000_000;
/** Each remote multipart request fits comfortably below the Worker inbound limit. */
export const VIDEO_UPLOAD_PART_BYTES = 5 * 1024 * 1024;
export const VIDEO_UPLOAD_LINK_MS = 60 * 60 * 1000;
/** Legacy buffered reads are restricted to small provider uploads. */
export const BUFFERED_VIDEO_MAX_BYTES = 50_000_000;
export const FACEBOOK_VIDEO_TRANSPORT_MAX_BYTES = 20_000_000;
/** Retain the existing direct-to-Bluesky transport ceiling while storage grows. */
export const BLUESKY_VIDEO_TRANSPORT_MAX_BYTES = 50_000_000;
