# GS Poster production incident: Error 1102 during Across the Barricade approval

**Incident time:** 2026-11-23 21:34:03 UTC (22:34 Copenhagen).
**Affected Worker:** `gs-poster`, production workers.dev, `/post/p_mwtqgvcudcbeb16b09/approve`.
**Cloudflare Ray ID:** `a5f34bad98b04f8e`.
**Cloudflare outcome:** `exceededCpu`, 10 ms CPU, about 1,315 ms wall time, HTTP 503.
**User impact:** The owner entered a PIN and clicked Approve, received Error 1102, and saw no TikTok inbox transfer.

## Confirmed state

Direct read-only production Cloudflare observability query identified this exact route and request ID with `Worker exceeded CPU time limit.` Direct D1 readback subsequently confirmed the affected `posts` row remained `draft` with `approved_at = NULL`, no Facebook post identifier, and unchanged version `2026-11-23T21:19:10.366Z`. A query of `tiktok_inbox_transfers` for this post returned no rows. The GS Poster read-only connector showed the Bluesky target was still `draft` and the private MP4 remained owner-ready at **42,262,722 bytes**. The owner separately confirmed there was nothing in the TikTok inbox. This is confirmation that no durable TikTok transfer was claimed; it does not independently prove the absence of all remote side effects.

## Root-cause analysis

Production `main` at `90b572402375353ef763174d824c34bebc23eaec` runs `fetchVideo` in `src/web.ts` as the Bluesky preflight, before calling `sendTikTokOnApproval` or `approveAndPublish`. For a private video, `src/video.ts` reads the complete R2 object with `readUpload` / `arrayBuffer`. That requires allocating and inspecting a 42 MB object inside a Worker request and is the most plausible cause of the observed 10 ms CPU budget exhaustion. The exact internal instruction was not recorded; therefore this is a strongly supported hypothesis rather than a sampled CPU-profile proof.

The unmerged large-video PR #94 already replaces the Bluesky preflight with a streamed check, and streams Bluesky's provider upload, but its TikTok path still called `privateVideoRange`, which materialized each 10 MB R2 range as a byte array. This remains risky under the observed budget. Facebook preflight also buffered before checking the existing 20 MB provider limit.

## Proposed fix (stacked on PR #94)

**Branch:** `chatgpt/streamed-approval-video-cpu-20261123`.
**Base:** PR #94 at `7b9f5a8176955c240f5c0fe8a5ede9f81d3cd035`.
**Role:** ChatGPT-1 | Implementer.
**Review depth:** **Full review** because private-media reads and provider transfers cross an external trust boundary. The implementation session is not an independent reviewer.

Changes:
- `src/video.ts`: add a private R2 byte-range **stream** reader limited to 20 MiB per call; validate type and bounds; never call `arrayBuffer` on the chunk.
- `src/tiktok-inbox.ts`: pipe each bounded R2 range through `FixedLengthStream` to TikTok, checking status and awaiting complete transfer; preserve the existing transfer claim, publish identifier checkpoint and ambiguity tracking.
- `src/web.ts`: use stream size inspection for Facebook approval preflight instead of buffering a video larger than Facebook's 20 MB ceiling. Existing publication checks remain in force.
- Tests cover the **exact 42,262,722-byte** incident size, up to 300 MB, correct multipart ranges, provider consumption, no buffered R2 chunk access, interrupted transfer remaining in `needs_review`, oversized Facebook rejection before approval, combined one-PIN TikTok + Bluesky media and second-click replay denial.

## Security and recovery model

- The uploaded private reference must already be selected in the saved draft. This change does not expose new URLs, add an upload endpoint, accept external hosts, modify the PIN, or bypass existing target approval.
- R2 range reads remain constrained by `parseUploadRef` and a strict maximum chunk size. An external TikTok URL still passes the preexisting provider-host allowlist.
- TikTok's claimed transfer row and remote publish identifier checkpoint remain unchanged. A failure or incomplete stream after remote initiation remains ambiguous and may require owner reconciliation. No automatic retry is added.
- `FixedLengthStream` is expected to enforce the exact body length in Cloudflare workerd. The direct Node test uses a nonenforcing transform shim and separately verifies outgoing bytes; the bundled workerd test is required to validate actual fixed-length semantics.
- No code is authorized to make a public post in this development session.

## Release gates

1. **Run tests on the exact branch commit:** `npm ci`, `npm run check`, and `npx wrangler deploy --dry-run --outdir dist`. These were **not run here** because the isolated container cannot reach GitHub and does not contain repository dependencies. Do not treat the added assertions as passing tests.
2. Independently re-review the complete affected path (including unchanged `src/tiktok-inbox.ts` claim/uncertain-state handling, `src/video.ts` media provenance, `src/web.ts` target selection and `src/bluesky.ts` streaming publication). The existing Full review requirements for PR #94 still apply and do not transfer automatically to this head.
3. Validate an **isolated** 42.3 MB one-PIN TikTok + Bluesky transfer using real R2 and actual Workers CPU constraints. Verify upload count and no duplicate, actual remote provider acceptance, failure/retry reconciliation, and costs/credits before any production rollout.
4. Owner must explicitly authorize merge/deploy under current GS Poster policy. Do not start GitHub Actions or deploy without verifying a credit-free route and necessary approvals.
5. **Do not retry the existing 42.3 MB production draft on current Worker code.** It is still a draft and has no TikTok transfer record. For an immediate social teaser, a separately uploaded smaller video is a temporary alternative, but must be explicitly reviewed.

This correction is deliberately **stacked** on the unmerged PR #94 branch to avoid deploying conflicting partial video implementations. It is not a hotfix released to production.
