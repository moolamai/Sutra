# Native SLM bindings (B6) — public PRD

**Spec IDs:** CK-03 · **Status:** Shipped in Sutra 1.0

Ship certified on-device model runtimes behind `SlmRuntime` and `ModelInterface`: llama.cpp (desktop/server), ONNX Runtime Mobile (Android), MLX (Apple silicon), and an Android AICore seam with capability probe and graceful absence. Certification — B0 model obligations, B1 locality, and P4 profile benches — is the bar for the Certified Binding badge.

## Goals

- `packages/bindings-slm`: `LlamaCppSlmRuntime` with model card, deadline abort, stable embed dimension.
- Mobile adapters: `OnnxSlmRuntime`, MLX adapter, AICore seam with absence-safe fallback.
- One-command certification: `bindings-slm certify --profile <id> --adapter <name>`.
- Public checklist and badge criteria for third-party adapter authors.

## Non-goals

- Feature parity across engines (quantization, context, streaming differ by runtime).
- Replacing HTTP reference runtimes — native adapters are additive.

## Exit gates (1.0)

- At least one desktop and one mobile profile produce committed certification report artifacts.
- Harness runs conformance + locality + profile benches in a single CLI invocation; non-zero exit on any breach.
- Governance doc cross-links checklist, package quickstart, and B0 obligation catalog.

## Public links (implementors)

| Link | Purpose |
|------|---------|
| [`CERTIFIED-BINDING.md`](./CERTIFIED-BINDING.md) | Checklist + Certified Binding badge criteria |
| [`packages/bindings-slm/README.md`](../../packages/bindings-slm/README.md) | Certify locally in under 15 minutes |
| [`packages/contract-conformance/src/obligations/model.ts`](../../packages/contract-conformance/src/obligations/model.ts) | B0 / CK-03 model obligation catalog (`CK-03.1`–`CK-03.3`) |
| [`docs/PRD_MATRIX.md`](../PRD_MATRIX.md) | Public spec matrix |
