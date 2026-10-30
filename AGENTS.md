# GS Poster: shared agent entry point

Read [CLAUDE.md](CLAUDE.md) first for GS Poster's existing hard rules and merge/deployment restrictions. These remain authoritative. For any code change or review, also consult the cross-project [GS Tools Hub review-depth playbook](https://github.com/GSGrimoire/gs-tools-hub/blob/main/docs/REVIEW_PLAYBOOK.md) and its [risk-based agent rules](https://github.com/GSGrimoire/gs-tools-hub/blob/main/AGENTS.md) when access is available. The Hub is private; inability to open the playbook is not permission to bypass GS Poster's own security rules.

## Choosing review depth

State **Mini review** or **Full review** before implementation, in the issue or pull request.

- **Mini review:** only clearly bounded routine changes without authentication, private data, external file transfers, persistence uncertainty, publication/approval, secrets, or other security/privilege effects. Requires a documented creator diff inspection and relevant checks. A second session is not automatically needed unless existing GS Poster rules require it.
- **Full review:** required for changes involving OAuth/editor access or revocation, all Model Context Protocol tool permissions, private R2 objects and `upload://` ownership, download URL/redirect handling, uploaded-file integrity, uncertain database/storage commits, audits, publication PIN/approval or other privileged boundaries. A reviewer must examine the **whole affected security path**, including unchanged callers, siblings, state transitions, failures and recovery, not only the function edited. Successful automated tests are not security approval.

The Full review begins with an entry-point inventory, trust/threat model, invariants, state and failure-mode matrix, adversarial tests, and exact pinned commit. Require a separate reviewer session or qualified human before merger or deployment. Keep live ChatGPT attachment-transfer and real original-file hash acceptance distinct from source security approval.

## Naming same-model sessions

When multiple ChatGPT sessions collaborate on one change, name them **ChatGPT-1 | Implementer** and **ChatGPT-2 | Independent Reviewer**, or assign unique higher numbered names with clear roles. Put these labels in the first pull-request comment, relevant review, and handoff, alongside the actual GitHub account and exact commit. The implementation session must not independently approve its own changes. Two sessions with the same GitHub identity cannot produce a formal approving review of that account's own pull request. Named sessions are traceability labels, not proof of independent human review.

Keep the GS Poster approval and publishing protections in [CLAUDE.md](CLAUDE.md) unchanged.
