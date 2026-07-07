# Benchmarks

This repository is infrastructure, so performance is a feature. These microbenchmarks track the latency budget of every hot path the platform owns. All benchmarks execute locally with deterministic inputs and no external dependencies, making results reproducible across commits on the same machine.

```bash
pnpm install && pnpm build     # from the repository root
cd benchmarks
pnpm all                       # or an individual benchmark below
```

| Benchmark | Path measured | Engineering rationale |
|---|---|---|
| `pnpm crdt-merge` | `CrdtHarnessResolver.merge` including schema validation | Cloud handoff cost per reconnecting device; bounds sync throughput per core |
| `pnpm memory-retrieval` | `LocalVectorDb.search` over 1k/5k/20k vectors | Memory retrieval sits inside every turn; on-device budgets are tight |
| `pnpm sync-roundtrip` | `SyncEngine.synchronize` + real merge, in-process transport | Edge-to-cloud handoff floor, excluding network |
| `pnpm core-loop` | `CognitiveCore.turn` with instant bindings | The reasoning-latency overhead the infrastructure itself adds |

## Philosophy

Benchmarks exist to protect latency budgets as the infrastructure evolves. They are intended to detect regressions introduced by architectural changes, not to compare hardware or compete with model providers.

## Methodology

Each benchmark performs a warm-up phase before collecting measurements to reduce JIT compilation effects. Results report p50, p95, p99, and mean latency using the shared benchmarking harness (`_shared/bench.mjs`). Numbers are machine-relative: use them to compare commits on the same machine, not to compare machines. CI treats benchmarks as compile-and-run smoke checks; regression gating against stored baselines is roadmap work.

## What is deliberately not here

The repository intentionally does not benchmark LLM inference, speech synthesis, speech recognition, or vision models. Those are implementation-specific concerns. Moolam benchmarks only the infrastructure it owns: memory, synchronization, orchestration, and cognitive execution overhead. Bind your production models and profile them with the same harness if you need end-to-end numbers.
