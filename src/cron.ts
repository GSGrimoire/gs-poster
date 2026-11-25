import { BLUESKY_DUE_FROM, blueskyClaimCutoff } from "./db.ts";
import type { Env } from "./env.ts";
import { FACEBOOK_DUE_FROM, facebookClaimCutoff, processFacebookUploadBatch } from "./facebook-queue.ts";
import { INSTAGRAM_WORK_EXISTS, instagramConfigured, processInstagramBatch } from "./instagram-publish.ts";
import { publishDueBluesky } from "./publish.ts";

const HAS_SCHEDULED_WORK = `SELECT (
  EXISTS (SELECT 1 ${FACEBOOK_DUE_FROM})
  OR EXISTS (SELECT 1 ${BLUESKY_DUE_FROM})
  OR (? = 1 AND (${INSTAGRAM_WORK_EXISTS}))
) AS has_work`;

export async function processScheduledWork(env: Env): Promise<void> {
  const now = new Date();
  const iso = now.toISOString();
  try {
    const pending = await env.DB.prepare(HAS_SCHEDULED_WORK)
      .bind(facebookClaimCutoff(now), blueskyClaimCutoff(iso), iso, Number(instagramConfigured(env)),
        iso, iso, iso, iso).first<number>("has_work");
    if (pending === 0) return;
  } catch {
    // A fresh or older database may lack a table or column. The existing
    // batches handle their own setup. A probe error must not starve them.
    console.warn("Scheduled work lookup failed. Running the platform batches.");
  }
  // One platform failure must not prevent the other approved queues from running.
  let failed = false;
  try { await processFacebookUploadBatch(env); }
  catch { failed = true; console.error("Facebook upload batch failed."); }
  try { await publishDueBluesky(env); }
  catch { failed = true; console.error("Bluesky scheduled batch failed."); }
  try { await processInstagramBatch(env); }
  catch { failed = true; console.error("Instagram scheduled batch failed."); }
  if (failed) throw new Error("One or more scheduled publication batches failed.");
}
