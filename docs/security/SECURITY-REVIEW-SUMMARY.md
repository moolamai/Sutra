# Sutra security review — adopter summary

> Public summary of the P7 external-equivalent security review. For the full engagement record see [`security/EXTERNAL-REVIEW.md`](../../security/EXTERNAL-REVIEW.md) and the threat model at [`security/THREAT-MODEL.md`](../../security/THREAT-MODEL.md). To report a vulnerability, see [Reporting a vulnerability](#reporting-a-vulnerability) below.

Sutra is sovereign cognitive infrastructure: third parties build on it and deploy it with their own learner, clinical, and legal data. Before the 1.0 freeze, the protocol and platform underwent a structured security review held to external-equivalent independence rules. This page is the adopter-facing summary — what was reviewed, how, what was found, and how to report new issues.

## What was reviewed (scope)

The review targeted design and implementation flaws — **not just dependency CVEs**. Four trust surfaces were in scope, each mapped to the trust boundary inventory in the threat model:

| Surface | What it covers |
|---------|----------------|
| Wire protocol parsing | Malformed, oversized, duplicate-key, and type-confused payloads against the Zod/Pydantic wire boundary ("parse, never cast") |
| P2 auth boundary | Missing/forged/expired credentials, cross-subject scope escalation, operator-wildcard misuse, credential leakage |
| B4 tool execution sandbox | Model-output tool injection, `riskClass` downgrade, approval-hook bypass, write-ahead audit evasion, deadline/payload exhaustion |
| Sync path and CRDT merge | Replay/duplicate double-application, concurrent same-subject interleaving, HLC regression, audit repudiation, content exfiltration |

A dependency CVE scan and default-configuration review were performed as the floor of the engagement, not its substance.

## How it was reviewed (methodology)

The review was conducted as a structured internal red team under external-equivalent independence rules: no reviewer audited code they authored, reviewers worked from a fresh clone at a pinned commit with published docs only, and attack attempts were written against each surface's goals **before** reading the documented mitigations. Each surface concluded with a named reviewer sign-off.

Per surface, the reviewers ran a STRIDE walk, adversarial input testing, an auth-bypass matrix, sandbox-escape attempts, and replay/idempotence probes — every step producing evidence (a failing input, transcript, or test link) attached to the findings register. Review fixtures used synthetic subjects only; no real learner content entered any review artifact, and evidence carries `subjectId` metadata rather than raw utterances.

## What was found (finding counts)

The review filed **9 findings**. Severity is the reviewer's worst-case filed severity, so the counts show the review reached the P0/P1 surfaces rather than downgrading on contact.

| Severity | Count |
|----------|-------|
| P0 | 2 |
| P1 | 4 |
| P2 | 1 |
| P3 | 2 |
| **Total** | **9** |

By closure status:

| Status | Count |
|--------|-------|
| Closed (fixed/verified with re-test evidence) | 7 |
| Accepted (residual risk with owner and review date) | 2 |
| Open | 0 |

## Closure status

**All P0 and P1 findings are closed with re-test evidence — there are no open P0/P1 findings.** Every closed finding is locked by a regression test that exercises the vulnerable behavior; each P0/P1 finding resolved to an already-enforced platform mitigation on re-test. The two accepted findings are transport confidentiality (TLS is deployment-owned) and host tool-sandbox isolation (depends on the host `ToolInterface`); both are recorded as residual risks with a named owner and review date in the threat model, not silently ignored.

Under the review's severity policy, open P0/P1 findings block freeze RFC acceptance until closed. With zero open P0/P1 findings, the security review does not block the 1.0 freeze.

## Sovereignty posture

The review confirmed the platform's sovereignty invariants hold across the reviewed surfaces: every read and write is scoped by `subjectId`, cross-subject access is denied at the boundary, and no raw learner content crosses the declared locality boundary (`on-device` / `self-hosted`) — sync carries structured cognitive-state and friction metadata only. This summary itself reports aggregate counts and closure status; it publishes no exploit detail and no learner content.

## Reporting a vulnerability

If you find a security issue in Sutra, **do not open a public issue.** Report it privately:

- GitHub: **Security → Report a vulnerability** (private advisory) on the repository
- Email: **security@moolam.org**

The full reporting process, disclosure timelines, and in-scope/out-of-scope lists are in the repository [`SECURITY.md`](../../SECURITY.md). We follow coordinated disclosure and credit reporters unless anonymity is requested.

## References

- Engagement record and findings register: [`security/EXTERNAL-REVIEW.md`](../../security/EXTERNAL-REVIEW.md)
- STRIDE threat model and residual risk register: [`security/THREAT-MODEL.md`](../../security/THREAT-MODEL.md)
- Vulnerability reporting policy: [`SECURITY.md`](../../SECURITY.md)
