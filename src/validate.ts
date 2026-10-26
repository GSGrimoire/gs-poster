/**
 * House rules from the gsgrimoire-release-schedule skill, plus Facebook's limits.
 *
 * Errors block Claude's drafts. On the approval page they are shown to Gus as
 * warnings he can override: the rules bind Claude, not him.
 */

export interface CheckResult {
  errors: string[];
  warnings: string[];
}

const FB_MAX_MESSAGE = 63_206;
export const MAX_IMAGES = 80;
export const FACEBOOK_IMAGE_BATCH_SIZE = 8;

/** Facebook: a scheduled post must be 10 minutes to 30 days out. */
export const FB_MIN_LEAD_MS = 10 * 60 * 1000;
export const FB_MAX_LEAD_MS = 30 * 24 * 60 * 60 * 1000;
/** Margin used at approval time, so the request does not land at 9m59s. */
export const APPROVE_MIN_LEAD_MS = 12 * 60 * 1000;
/** At draft time, leave Gus room to get round to approving. */
export const DRAFT_MIN_LEAD_MS = 30 * 60 * 1000;

const PRICE = /[$€£]\s?\d|\b\d+(?:[.,]\d+)?\s?(?:kr\.?|dkk|usd|eur|dollars?|kroner)(?![a-z])/i;
const TOOL_NAMES = /\b(suno|midjourney)\b/i;
const RETIRED_TIERS = /\b(wanderer|grand archivist)\b/i;
const RETIRED_LINES = /a bargain,? really/i;

export function checkMessage(message: string, opts: { hasImages: boolean }): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = message ?? "";

  if (!text.trim() && !opts.hasImages) errors.push("The post is empty: add a caption or at least one image.");
  if (text.length > FB_MAX_MESSAGE) errors.push(`Caption is ${text.length} characters; Facebook allows ${FB_MAX_MESSAGE}.`);

  if (text.includes("—")) errors.push("Contains an em dash (—). House rule: never use em dashes.");
  if (/\s–\s/.test(text)) warnings.push("Contains a spaced en dash ( – ), which reads as an em dash.");
  const tool = TOOL_NAMES.exec(text);
  if (tool) errors.push(`Names a generative tool ("${tool[1]}"). House rule: never name Suno, Midjourney or similar.`);
  const price = PRICE.exec(text);
  if (price) errors.push(`Looks like a price ("${price[0].trim()}"). House rule: never print a price; name the tier.`);
  const tier = RETIRED_TIERS.exec(text);
  if (tier) errors.push(`Uses a retired tier name ("${tier[1]}"). Tiers are Free, Scribe and Tome Keeper.`);
  if (RETIRED_LINES.test(text)) errors.push('"A bargain, really" is a retired line.');

  if (text.trim() && !/patreon\.com|\barchive\b/i.test(text)) {
    warnings.push("No Patreon link and no mention of the Archive. Fine for some posts; check the call to action.");
  }
  const exclaims = (text.match(/!/g) || []).length;
  if (exclaims >= 3) warnings.push(`${exclaims} exclamation marks. The house voice is not exclamatory.`);

  return { errors, warnings };
}

/**
 * Check a planned publish time. `null` means "post as soon as Gus approves".
 * Returns an error message, or null when the time is fine.
 */
export function checkWhen(when: Date | null, now: Date, minLeadMs: number): string | null {
  if (!when) return null;
  const lead = when.getTime() - now.getTime();
  if (lead < minLeadMs) {
    const mins = Math.round(minLeadMs / 60000);
    return `The publish time is less than ${mins} minutes away. Pick a later time, or leave it empty to post on approval.`;
  }
  if (lead > FB_MAX_LEAD_MS) return "Facebook only schedules up to 30 days ahead.";
  return null;
}
