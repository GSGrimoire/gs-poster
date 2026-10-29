# Facebook Groups publishing feasibility for GS Poster

**Researched:** 29 October 2026  
**Decision:** **No supported public API for direct third-party Facebook Group posts**. Implement a manual group-publishing handoff and an accountable completion log instead. Keep the existing Facebook Page Graph API integration unchanged.

## Platform status

Meta's Graph API v19.0 changelog deprecated `publish_to_groups`, `groups_access_member_info`, the Facebook Groups API itself, and admins' ability to install third-party applications in groups. The removal took effect **22 April 2024**, across API versions, including groups administered by the app owner.

Official changelog URL (may require an authenticated developer session):
- https://developers.facebook.com/docs/graph-api/changelog/version19.0

Cross-checks:
- Sprinklr's deprecation notice: https://www.sprinklr.com/help/articles/getting-started-facebook/meta-deprecates-facebook-groups-api/66229eb25f9dd9599d632712
- Restream's 2026 support note: https://support.restream.io/en/articles/9041527-facebook-groups-api-changes
- Zapier's removed Facebook Groups integration: https://help.zapier.com/hc/en-us/articles/23970212345357-App-update-Facebook-Groups-app-removal

**Critical distinction:** GS Poster's `pages_manage_posts` and Page token authorize Page posting, **not** Facebook Group posting. Owning/administering a group does not reinstate a public group publishing API.

Claims by extensions/vendors to use Facebook's private GraphQL endpoints or browser automation do not establish supported platform access. **Do not add an undocumented endpoint, session-cookie replay, or headless stealth-posting feature to GS Poster.** This is a maintainability, account-security and platform-compliance risk.

## Recommended supported workflow

Build a separate **Facebook Group manual dispatch** target:

- Group name, canonical group URL, optional local shorthand or campaign, and whether the user is a group member/admin.
- A separate group-specific caption and permitted links, media selection, hashtags, media download package, and reminder date/time. Support multiple group destinations as separate tasks.
- At the due time, show a **Ready to post manually** state, not Scheduled or Published. Offer a link to open the group in Facebook and copy the prepared text.
- Provide **copy caption**, **download images/video** from an authenticated GS Poster screen, and **open group** actions. This does not attempt to prepopulate or submit an undocumented Group composer.
- Require a human **Mark as posted** action, recording the user, time, group, and an optional permalink. The system must never infer success from link opening or copy actions.
- Offer a quick **Not permitted in this group** status and maintain a checklist of group rules. Respect each group's promotional restrictions; do not queue bulk spam to unrelated communities.
- Keep the existing GS Poster calendar and archival history for manually completed posts, distinct from API-published Facebook Page posts.
- Optional reminders or delivery via the approved reminder/email system, only with explicit consent.

## Proposed data and interface

- `community_targets`: `type=facebook_group`, `group_url`, `display_name`, `posting_rules_note`, `enabled`, `updated_at`.
- `manual_dispatches`: `post_id`, `target_id`, `caption`, `image_refs`, `video_ref`, `due_at`, `state`, `prepared_by`, `completed_by`, `completed_at`, `reported_permalink`.
- States: `draft`, `ready`, `manual_action_needed`, `completed_unverified`, `cancelled`. Never display `published` unless explicitly labeled **manually reported**.
- Separate approval for group-specific copy. The Model Context Protocol (MCP) connector may prepare drafts but cannot mark completion or post on the user's behalf without explicit approval.

## Acceptance criteria

1. Group tasks never call Meta's retired or private Groups endpoints.
2. Opening a group or copying copy never silently marks a post as released.
3. A user can select multiple distinct groups and track manual status separately.
4. The calendar distinguishes Group manual handoff from an API-scheduled Facebook Page publication.
5. Only the authenticated owner can retrieve private media for a manual handoff.
6. Preserve created-by agent attribution, per-group notes and the existing publishing PIN protections.

## Dependencies and caveats

- No official Meta developer app permission can be added to resurrect retired Groups posting.
- Facebook's Page publishing remains a separate supported workflow.
- If Meta introduces a new officially documented Groups publishing product, reassess permission, review and account requirements against current documentation before redesigning.

**Recommendation:** Put manual Group dispatch ahead of any attempt at direct automated Group publishing. Direct Group publishing should remain blocked unless Meta provides a new public supported API.
