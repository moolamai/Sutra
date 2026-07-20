# Implementor quickstart — install → first turn → sync

End-to-end path for a stranger who does **not** work inside the Sutra monorepo: scaffold with `create-sutra`, install `sutra-sdk`, configure a domain, run one turn, then enable sync.

**Verified:** 2026-07-16 · Node.js 22 · pnpm/npm on a clean project directory outside the monorepo (scaffold output under `~/sutra-companions/`).

## What you will have

| Step | Outcome |
|------|---------|
| Scaffold | A typed companion project with domain + storage + transport stubs |
| Install | `sutra-sdk@^1.0.0` from npm — no `workspace:` links |
| First turn | `npm run smoke` runs one `CognitiveCore` turn scoped by `subjectId` |
| Sync | HTTP transport posts `SyncRequest` to `/v1/sync` with subject isolation + idempotent `syncAttemptId` |

## Prerequisites

- Node.js **≥ 22**
- npm **≥ 10** (or pnpm / yarn — examples use npm)
- Network access to install `sutra-sdk` (or a packed tarball while registries are still in dry-run)

```bash
node -v   # v22.x
```

## 1. Scaffold with `create-sutra`

Generate the project **outside** any Sutra checkout so your app never inherits monorepo workspace protocol.

**Non-interactive (copy-paste):**

```bash
# When @moolam/create-sutra is on the scratch registry (P7 — see stranger-test P7-RFC-INTENT-002):
#   npx @moolam/create-sutra --name my-companion --domain teacher \
#     --storage memory --transport http --out ~/sutra-companions/my-companion --yes

# Contributor / pre-publish path (run from a Sutra checkout, write OUTSIDE it):
pnpm create-sutra --name my-companion --domain teacher \
  --storage memory --transport http \
  --out ~/sutra-companions/my-companion --yes
```

> Stranger-test (2026-07-16): bare `npm install` against public npm fails with 404 until scratch packs (§2.2). Always install from scratch scope before smoke.

Choices used above:

| Choice | Value | Why |
|--------|-------|-----|
| Domain | `teacher` | Ships charter, refusals, and a small task graph |
| Storage | `memory` | Fastest smoke; swap later for `sqlite` / `expo-sqlite` |
| Transport | `http` | Enables sync in §5 (`offline` skips cloud) |

Open the generated README — it lists the same next steps.

## 2. Install the SDK

### 2.1 When the registry is live

```bash
cd ~/sutra-companions/my-companion
npm install
npm run typecheck
```

`package.json` depends on `"sutra-sdk": "^1.0.0"` only — no `workspace:` links.

### 2.2 Before npm 1.0.0 is live

If `npm install` returns **404**, the `v1.0.0` tag has not been published yet. Until then:

**Option A — monorepo sibling (contributors):** clone [moolamai/sutra](https://github.com/moolamai/Sutra), `pnpm build`, and use `file:` overrides or pack tarballs.

**Option B — rehearsal packs (operators):**

```bash
pnpm --filter sutra-sdk... build
pnpm publish:pack
pnpm publish:rehearsal:verify
```

**Option C — after publish:**

```bash
npm install sutra-sdk@1.0.0
```

**Option D — explicit `file:` overrides** (copy into companion `package.json` after `pnpm publish:pack`):

Pack at least: `sdk`, `contracts`, `cognitive-core`, `runtime`, `telemetry`, `sync-protocol`, `edge-agent`, and **`observability`** (transitive via edge-agent — omitting it fails install).

```json
{
  "dependencies": {
    "sutra-sdk": "file:./scratch/moolam-sdk-1.0.0.tgz"
  },
  "pnpm": {
    "overrides": {
      "sutra-sdk": "file:./scratch/moolam-sdk-1.0.0.tgz",
      "@moolam/contracts": "file:./scratch/moolam-contracts-1.0.0.tgz",
      "@moolam/cognitive-core": "file:./scratch/moolam-cognitive-core-1.0.0.tgz",
      "@moolam/runtime": "file:./scratch/moolam-runtime-1.0.0.tgz",
      "@moolam/telemetry": "file:./scratch/moolam-telemetry-1.0.0.tgz",
      "@moolam/sync-protocol": "file:./scratch/moolam-sync-protocol-1.0.0.tgz",
      "@moolam/edge-agent": "file:./scratch/moolam-edge-agent-1.0.0.tgz",
      "@moolam/observability": "file:./scratch/moolam-observability-1.0.0.tgz"
    }
  }
}
```

```bash
pnpm install --ignore-workspace
pnpm exec tsc --noEmit
```

**Option C — verdaccio / GitHub Packages test org** pointed at by `.npmrc` (same package set as B).

Production registry publication is deferred to P7 ([P7-RFC-INTENT-001](../stages/tracks/track-a-sovereign-protocol/p5-distribution-dx/docs-site/stranger-test/P7-RFC-ENTRIES.md#p7-rfc-intent-001)); do **not** rewrite ranges to `workspace:*`.

## 3. Configure the domain

Edit `src/config/domain.ts`:

- `agentProfile.charter` / `refusals` / `languages` — product language for your companion
- `taskGraph` — prerequisite rows (data, not code)

Keep every durable write keyed by the same `subjectId` you pass into turns and sync. Cross-subject access is a defect.

## 4. Run the first turn

```bash
# Optional: pin smoke identity (never put raw learner content in these ids)
set SUTRA_SUBJECT_ID=demo-subject
set SUTRA_DEVICE_ID=demo-device

npm run smoke
```

On Unix shells use `export` instead of `set`.

Expected: exit **0**, a `create_sutra.smoke` JSON line with `outcome: "ok"`, `subjectId`, `deviceId` (no utterance body), and `smoke OK: reply length=…`.

Under the hood `scripts/smoke.ts` calls `runMockTurn` → `CognitiveCore.turn({ subjectId, sessionId, utterance })` with reference mocks. Replace `src/mocks/reference-bindings.ts` and `src/bindings/*` with production adapters when you leave the smoke path.

### Failure modes (turns)

| Failure | What you should see |
|---------|---------------------|
| Missing / empty `subjectId` | Typed throw before any side effect (`subjectId is required…`) |
| Downstream timeout / binding error | Rejected promise or smoke exit **1** with `outcome: "fail"` — never a silent catch |
| Concurrent turns same `subjectId` | Do not share one mutable core across overlapping turns; create a core per turn (scaffold does) or serialize — races on read-modify-write of cognitive state are defects |
| Partial failure after a durable write | Treat the turn as failed; retry only with a **new** `sessionId` / clear operator intent — never assume the first write can be ignored |

## 5. Enable sync

With `--transport http`, `src/bindings/transport.ts` exposes `createSyncTransport({ subjectId, baseUrl })`.

```bash
# Point at your cloud harness (default in stub: http://127.0.0.1:8000)
set SUTRA_SYNC_URL=http://127.0.0.1:8000
```

Minimal sync call (add as `scripts/sync-once.ts` or call from your host):

```ts
import { randomUUID } from "node:crypto";
import { bootstrapBindings } from "../src/index.ts";
import type { SyncRequest } from "sutra-sdk";

const subjectId = process.env.SUTRA_SUBJECT_ID ?? "demo-subject";
const deviceId = process.env.SUTRA_DEVICE_ID ?? "demo-device";
const { transport, offline } = bootstrapBindings(subjectId);

if (offline || !transport) {
  throw new Error("rebuild with --transport http to enable sync");
}

const request = {
  // Shape must match the published SyncRequest schema — validate at the boundary.
  syncAttemptId: randomUUID(), // idempotency key: replays must not double-apply
  edgeState: {
    subjectId,
    // …replica CognitiveState fields for your subject…
  },
} as SyncRequest;

const result = await transport.postSync(request);
if (result.kind !== "ok") {
  // Distinct classes: http-error vs network-error — do not swallow.
  console.error(JSON.stringify({
    event: "companion.sync",
    outcome: "fail",
    subjectId,
    deviceId,
    kind: result.kind,
  }));
  process.exit(1);
}

console.log(JSON.stringify({
  event: "companion.sync",
  outcome: "ok",
  subjectId,
  deviceId,
  syncAttemptId: request.syncAttemptId,
}));
```

Wire contract overview: [Protocol README](../protocol/README.md) (`POST /v1/sync`, `SyncRequest` / `SyncResponse`).

### Sync edge cases

| Case | Rule |
|------|------|
| `edgeState.subjectId` ≠ transport `subjectId` | Stub returns `http-error` **403** — refuse cross-subject sync |
| Replayed `syncAttemptId` | Cloud must treat as idempotent — never double-apply the same attempt |
| Network / HTTP failure | Surface `network-error` / `http-error`; retry with backoff and a **new** attempt id only when the prior attempt is known non-applied |
| Offline transport | `createSyncTransport` returns `null` — Edge stays local; no raw learner content leaves the device |

## 6. Sovereignty & observability

- Scope every read/write by `subjectId`. Never log raw utterances or learner payloads in plaintext events.
- Locality: prefer `on-device` / `self-hosted` for subject content; model output and wire payloads are untrusted — validate at the boundary.
- Emit structured events with `subjectId`, `deviceId`, and `outcome` (see smoke / sync examples above).

## 7. Next steps (published guides)

Do **not** stop at smoke mocks for production bindings:

1. **Conformance CLI** — [Implementor conformance quickstart](./conformance-quickstart.md)  
   Point a factory at your implementation; read obligation verdicts (`pnpm conformance` / package CLI).
2. **Binding certification** — [Certified Binding checklist](../bindings/CERTIFIED-BINDING.md)  
   Model / speech / vision adapters: one-command certify profiles and badge criteria.

API surface while you code: generated TypeDoc on the docs site (`/api/`) or [SDK interfaces](./INTERFACES.md).

## Checklist

- [ ] Project lives outside the monorepo
- [ ] SDK installed via live registry **or** scratch packs (§2.2, including `observability`)
- [ ] `npm install` / `pnpm install` + typecheck exit 0
- [ ] `npm run smoke` exits 0 with `subjectId` / `deviceId` events
- [ ] Domain charter/refusals edited for your product
- [ ] HTTP sync pointed at a harness; subject mismatch refused; `syncAttemptId` set
- [ ] Conformance + certification guides bookmarked before shipping adapters
- [ ] Restart mid-smoke still green; concurrent turns do not share one mutable core
