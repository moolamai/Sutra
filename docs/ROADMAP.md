# Sutra Roadmap

**Indian Sovereign AI Initiative · Moolam AI**

Sutra ships in deliberate stages. A stage is not "done" because code exists — it is done when acceptance criteria hold.

Sutra is **cognitive infrastructure**, not an application. Education is the first reference domain; the same contracts and core loop extend to law, medicine, finance, engineering, and beyond.

---

## Current status (July 2026)

| Milestone | Status |
|-----------|--------|
| [Protocol 1.0 freeze RFC](../rfcs/0001-protocol-1.0-freeze.md) | **Accepted** — `PROTOCOL_VERSION = "1.0.0"` |
| Production publish gate | **Unlocked** (`pnpm production-publish:gate`) |
| npm pack dry-run | **Green** (`pnpm publish:pack`) — 15 public `@moolam/*` packages |
| Security review (SEC-01) | Internal red team complete; P0/P1 closed |
| Field pilot (B8) | Findings FP-001…FP-004 closed |
| **npm registry** | **Pending** — tag `v1.0.0` + CI publish (see [PUBLISH-CHECKLIST.md](./sdk/PUBLISH-CHECKLIST.md)) |
| Reference companion app ([Swayam](https://github.com/moolamai/swayam)) | In development — not a Sutra deliverable |

**What 1.0 means for builders:** stable SDK surface, frozen wire protocol, executable conformance, certified binding program, reference edge and cloud hosts. **What it does not mean:** a finished consumer companion, full cross-app agentic automation, or a hosted Deep SaaS.

---

## Stage 0 — Protocol & contracts scaffold `COMPLETE`

Foundation: buildable Hybrid Cognitive Sync Protocol and domain-agnostic cognitive contracts.

Delivered: wire contract + CRDT merge (TS + Python), reference cloud engine, edge host, telemetry, Playground, PRD matrix, SDK barrel, domain specs, examples, benchmarks, RFC process.

---

## Stage 1 — Hardening & conformance `LARGELY DELIVERED`

Make contracts implementable with confidence.

**Delivered:**

- Executable obligation suites (`@moolam/contract-conformance`, `pnpm conformance`)
- AuthN/AuthZ at cloud API boundary with subject-scope enforcement
- Postgres-backed master state + `sync_audit` trail (when `SUTRA_PG_DSN` set)
- Versioned protocol changelog and deprecation policy
- `@moolam/contract-mocks` for prototyping
- Dependency-direction and publish-readiness gates in CI
- STRIDE threat model + external-equivalent security review

**Remaining / ongoing:**

- [ ] Property-based fuzz of merge orderings across TS and Python at scale
- [ ] Broader independent backend implementations passing conformance

---

## Stage 2 — Reference bindings & pilots `IN PROGRESS`

Real companions on real devices.

**Delivered:**

- Certified binding profiles: desktop llama.cpp, Android ONNX (`android-mid`), Apple MLX
- `sutra-bindings-slm`, `bindings-speech`, `bindings-vision`, `bindings-knowledge`
- Tool execution policy engine (risk classes, write-ahead audit)
- Teacher CBSE slice knowledge pack + field-pilot evidence
- Indic STT classroom-noise fixture (`FP-002` closed)
- Offline-edge live demo path (`offline-edge:live`)

**Remaining:**

- [ ] Sustained multi-week disconnected field trials at scale
- [ ] Production-sized task-graph packs beyond pilot slices
- [ ] Second non-education domain built end-to-end from `domains/`
- [ ] NFR targets on mid-range Android tracked continuously in CI

---

## Stage 3 — Ecosystem `NEXT`

Shared infrastructure across industries.

**Delivered (partial):**

- Protocol and cognitive contracts frozen at 1.0 with additive-only RFC policy
- Certified Binding program and independence-kit verifier
- Launch and migration documentation (`docs/releases/`)

**Remaining:**

- [ ] **npm/PyPI 1.0.0 publication** (CI tag `v1.0.0`)
- [ ] Community registry of domain packs and tool plugins
- [ ] Institution deployment blueprints (schools, firms, clinics, enterprises)
- [ ] Multilingual evaluation harness across major Indian languages
- [ ] Regulated-domain deployment guides with sector-specific audit mapping

---

## How to engage

| You are… | Now (1.0) | Next |
|---|---|---|
| **App developer / founder** | `pnpm install sutra-sdk@1.0.0` (after publish), run `examples/`, read [`docs/sdk/`](sdk/README.md) | Ship companion on certified bindings; join pilot programs |
| **Domain professional** | Audit PRD matrix and your spec under `domains/` | Contribute packs, task graphs, evaluation slices |
| **Contributor** | Conformance tests, bindings, docs | Registry, evaluation harnesses, independent backends |
| **End user** | Playground + offline-edge demos | Apps built on Sutra (e.g. Swayam) |
