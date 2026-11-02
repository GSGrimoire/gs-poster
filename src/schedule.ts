/**
 * Schedule rules shared by the editor, the approval route and the rollover
 * (issue #61). The lead times themselves are unchanged: 12 minutes at approval
 * for text, video and Bluesky; 30 minutes for Facebook photo posts, which go
 * through the durable upload queue and must still be at least ten minutes
 * ahead at the final Graph send. Shortening the photo lead needs measured
 * worst-case queue evidence first (issue #61 point 3); one fast run is not it.
 */
import { BULK_FACEBOOK_THRESHOLD, BULK_SCHEDULE_MIN_LEAD_MS } from "./facebook-queue.ts";
import { APPROVE_MIN_LEAD_MS, FB_MAX_LEAD_MS } from "./validate.ts";

export interface LeadInput { facebook: boolean; photos: number }

/** Minimum time between approval and the scheduled time for this post. */
export function minLeadFor(o: LeadInput): number {
  return o.facebook && o.photos > BULK_FACEBOOK_THRESHOLD ? BULK_SCHEDULE_MIN_LEAD_MS : APPROVE_MIN_LEAD_MS;
}

const STEP_MS = 5 * 60 * 1000;
/** Extra room in the editor's suggestion, for reviewing and typing the PIN. */
export const EDITOR_BUFFER_MS = 10 * 60 * 1000;
/** Extra room when the approval itself moves the time (request in flight, clock skew). */
export const ROLLOVER_BUFFER_MS = 3 * 60 * 1000;

/**
 * The earliest time that is valid now plus a buffer, rounded UP to the next
 * five minutes. Rounding is in UTC; Copenhagen's offsets are whole hours, so
 * local times also land on :00, :05, ... across daylight-saving changes.
 */
export function earliestValidTime(now: Date, o: LeadInput, bufferMs: number): Date {
  const t = now.getTime() + minLeadFor(o) + bufferMs;
  return new Date(Math.ceil(t / STEP_MS) * STEP_MS);
}

export type RolloverDecision =
  | { ok: true; when: Date | null; movedFrom?: Date }
  | { ok: false; error: string; suggestion?: Date };

/**
 * Decide the time an approval releases. A null time means "post now" and is
 * never replaced by a schedule. A too-close (or passed) time is only moved
 * when the owner ticked the opt-in rollover box on this approval.
 */
export function decideReleaseTime(when: Date | null, now: Date, o: LeadInput, rollover: boolean): RolloverDecision {
  if (!when) return { ok: true, when: null };
  const lead = when.getTime() - now.getTime();
  if (lead > FB_MAX_LEAD_MS) return { ok: false, error: "Facebook only schedules up to 30 days ahead." };
  if (lead >= minLeadFor(o)) return { ok: true, when };
  const next = earliestValidTime(now, o, ROLLOVER_BUFFER_MS);
  if (rollover) return { ok: true, when: next, movedFrom: when };
  const mins = Math.round(minLeadFor(o) / 60000);
  return {
    ok: false, suggestion: next,
    error: `The publish time is less than ${mins} minutes away${o.facebook && o.photos ? " (photo posts need 30 minutes for the upload queue)" : ""}.`,
  };
}
