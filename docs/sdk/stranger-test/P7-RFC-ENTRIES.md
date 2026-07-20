# P7 RFC intent entries — stranger-test DX deferrals

Explicit **P7** deferrals from stranger-test triage (STRATEST-002).  
These are RFC *intents* for Track A P7 (Production hardening / 1.0). Formal RFCs under `rfcs/` open when P7 work starts; until then this file is the authoritative deferral log (nothing waived silently).

Related phase PRD: [`../../../p7-production-hardening/PRD.md`](../../../p7-production-hardening/PRD.md).

---

## P7-RFC-INTENT-001

| Field | Value |
|-------|-------|
| **ID** | `P7-RFC-INTENT-001` |
| **Title** | Publish `@moolam/*` to production npm (and keep scratch scope for dry-run) |
| **Source finding** | F-002 (P0 env) |
| **Severity at deferral** | P0 for production registry; scratch packs unblock strangers now |
| **Problem** | `npm install` against registry.npmjs.org returns 404 for `sutra-sdk`. P5 forbids production publish before the P7 freeze RFC. |
| **Interim mitigation (P5)** | Documented scratch tarballs + `pnpm.overrides` / verdaccio / `pnpm publish:rehearsal:verify` in the implementor quickstart. |
| **P7 acceptance** | Stranger can `npm install sutra-sdk@^0.1.0` (or 1.0) from the agreed production registry without file: overrides; lockstep versions across re-exported packages. |
| **Status** | Deferred to P7 — not waived |

---

## P7-RFC-INTENT-002

| Field | Value |
|-------|-------|
| **ID** | `P7-RFC-INTENT-002` |
| **Title** | Publish `@moolam/create-sutra` to scratch (then production) registry |
| **Source finding** | F-004 (P2) |
| **Severity at deferral** | P2 |
| **Problem** | Strangers cannot run `npx @moolam/create-sutra` without a Sutra checkout; only `pnpm create-sutra` from the monorepo works today. |
| **Interim mitigation (P5)** | Implementor quickstart documents the contributor scaffold path and notes the pending published bin. |
| **P7 acceptance** | `npx @moolam/create-sutra --yes …` works against scratch scope in CI stranger rehearsal; production publish follows the same freeze gate as INTENT-001. |
| **Status** | Deferred to P7 — not waived |
