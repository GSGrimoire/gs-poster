## Review depth and session identities

- **Review depth:** Mini review / Full review
- **Why:** (Any OAuth, editor ownership or revocation, Model Context Protocol tools, file transfers, private uploads, integrity, uncertain storage commits, publishing or approvals require a **Full review**.)
- **Implementation session:** `ChatGPT-1 | Implementer` or another uniquely named worker:
- **Review session:** `ChatGPT-2 | Independent Reviewer` or a qualified human:
- **Exact base and proposed head commit:**
- **Issue and acceptance criteria:**

## Affected scope and security evidence

- Changed behavior and affected entry points, including unchanged callers:
- Security invariants, current identity and storage/approval boundaries (Full reviews):
- State transitions, failure modes, concurrency and ambiguous writes (Full reviews):
- Adversarial tests and commands actually run:
- Remaining uncertainty, independent original-file integrity and runtime acceptance gates:

## Review and release

- Creator's diff self-review and findings:
- Independent source-review decision, exact head and GitHub reviewer identity (Full reviews):
- Formal GitHub approval status, distinct from an explicit same-account COMMENT verdict:
- Merge and deployment authority, and tests still required after deployment:

Read [AGENTS.md](../AGENTS.md), [CLAUDE.md](../CLAUDE.md) and the linked Hub review playbook before submitting a security-sensitive change. Passing automated checks is necessary evidence, not security approval.
