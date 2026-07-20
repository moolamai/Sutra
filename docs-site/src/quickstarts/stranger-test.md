---
title: Stranger test
description: One-day integrate-from-docs protocol (no monorepo, no coaching)
---

# Stranger test

External engineers integrate Sutra in **under one day** using only the **public docs site** and **scratch-published packages** — no monorepo, no Slack coaching.

## Tester brief (give this to the stranger)

1. Open [Implementor quickstart](/reference/sdk/implementor-quickstart).
2. Scaffold with `create-sutra` (contributor path or scratch-published bin — not a monorepo clone of your app).
3. Install `sutra-sdk` from the **scratch registry or packed tarballs** (§2.2 of the implementor guide). Bare `npm install` against public npm will **404** until P7.
4. Include `@moolam/observability` in overrides — it is a transitive dependency of edge-agent.
5. Run `npm run smoke` with a synthetic `subjectId` / `deviceId`. Never put real learner content in logs.
6. From the same guide, state how you would enable HTTP sync and why `syncAttemptId` must be idempotent.

Facilitator: observe only. Record friction with severity. Protocol: [PROTOCOL](https://github.com/moolamai/sutra/blob/main/docs/sdk/stranger-test/PROTOCOL.md).

## Recordings & triage

| Artifact | Link |
|----------|------|
| Findings (executed) | [FINDINGS-2026-07-16](https://github.com/moolamai/sutra/blob/main/docs/sdk/stranger-test/FINDINGS-2026-07-16.md) |
| Triage dispositions | [TRIAGE-2026-07-16](https://github.com/moolamai/sutra/blob/main/docs/sdk/stranger-test/TRIAGE-2026-07-16.md) |
| P7 deferrals | [P7-RFC-ENTRIES](https://github.com/moolamai/sutra/blob/main/docs/sdk/stranger-test/P7-RFC-ENTRIES.md) |
