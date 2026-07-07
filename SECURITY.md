# Security Policy

Sutra is infrastructure intended for deployments that handle learner data, clinical context, legal matter files, and other sensitive information. We treat security reports with corresponding seriousness.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately via either channel:

- GitHub: **Security → Report a vulnerability** (private advisory) on the repository
- Email: **security@moolam.org**

Include, as far as you can:

- Affected package(s) and version/commit
- A reproduction or proof of concept
- Impact assessment: what an attacker gains, and any preconditions
- Suggested remediation if you have one

## What to expect

| Milestone | Target |
|---|---|
| Acknowledgement of report | within 72 hours |
| Initial assessment and severity triage | within 7 days |
| Fix or mitigation for confirmed critical/high issues | within 30 days |
| Coordinated public disclosure | after a fix ships, credited to the reporter unless anonymity is requested |

We follow coordinated disclosure: we ask that you do not publish details until a fix is released and deployers have had reasonable notice. We will never take legal action against good-faith research conducted within this policy.

## Scope

In scope:

- All packages in this repository (`contracts`, `cognitive-core`, `runtime`, `telemetry`, `sync-protocol`, `edge-agent`, `cloud-orchestrator`, `sdk`, `playground`)
- The self-host stack in `infra/`
- Protocol-level issues: CRDT merge abuse (e.g. clock-skew attacks beyond the documented clamp), sync idempotency bypass, contract validation gaps
- Contract obligation bypasses with security impact: tool risk-class circumvention, audit-trail evasion, locality misdeclaration paths

Out of scope:

- Vulnerabilities exclusively in third-party dependencies (report upstream; tell us if Sutra's usage amplifies them)
- Issues requiring physically compromised devices
- Social engineering of project members
- Denial of service through obviously unreasonable resource exhaustion in a dev-mode deployment

## Supported versions

Pre-1.0 (current): only the latest release/`main` receives security fixes. From contract 1.0 (roadmap Stage 3): the latest major protocol version plus one prior receive fixes, per the support window published in release notes.

## Deployment hardening notes

Until the Stage 1 authn/authz criteria land, the reference cloud engine has **no authentication layer**; do not expose it to untrusted networks. Run it behind your own gateway, keep `SUTRA_PG_DSN` credentials out of source control, and treat the Playground as a development tool, not a production surface.
