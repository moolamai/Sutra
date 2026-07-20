# Android AICore seam (native host contract)

TypeScript authority: `packages/bindings-slm/src/aicore_seam.ts`.

- `probe()` is side-effect free — no session materialization, no download kickoff.
- Capability JSON fixtures under `fixtures/` document the truthful surface for CI.
- Kotlin `AicoreCapabilityProbe` mirrors the probe shape for Android hosts (MediaPipe LLM / AICore).
- `createAicoreSlmRuntimeCandidate` returns `null` or typed unavailable when absent; `planEdgeSlmRuntimeLoad` / Kotlin `AicoreFallbackPlanner` try the next candidate without crash loops.
- Device scenarios under `scenarios/` (capable / absent / downloading) drive integration tests: AICore when ready, ONNX mobile fallback when absent; zero egress on the capable path.

Production hosts inject an `aicore-mediapipe` backend; Node CI uses the in-process stand-in.
