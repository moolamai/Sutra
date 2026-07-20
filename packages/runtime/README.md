# @moolam/runtime

Reference in-process implementations of the runtime contracts: the execution environment seams an agent needs from whatever hosts it. Phones, servers, and test harnesses implement the same four contracts; this package provides the plain, dependency-free versions that serve tests, examples, and simple deployments.

## Architecture

| File | Implements | Contract (from `@moolam/contracts`) |
|---|---|---|
| `src/lifecycle.ts` | `RuntimeHost` | `LifecycleAware` management with strict one-way transitions (suspend/resume excepted) |
| `src/scheduler.ts` | `InProcessScheduler` | `SchedulerInterface`: deferred and periodic tasks over plain timers |
| `src/events.ts` | `InProcessEventBus`, `ValidatingEventBus` | `EventBusInterface`: pub/sub for observations, never control flow |

Design philosophy lives in `design/runtime.md`; the decision record is ADR 0005.

## Event catalog (implementors)

Typed EventBus domain events (`turn.stage.*`, `sync.outcome`, `sync.advisory`,
`tool.*`, …) are defined in `@moolam/observability` with Zod schemas and
committed JSON Schema under `packages/sync-protocol/schemas/Event*.json`.

**Reference (trigger, payload, privacy, worked examples):**
[`../observability/docs/event-catalog.md`](../observability/docs/event-catalog.md)

Prefer `createValidatingEventBus()` from `@moolam/observability` so unknown types
and learner-content keys are rejected at publish. Bare `InProcessEventBus` stays
available for untyped test fixtures.

## Public API

`RuntimeHost`, `InProcessScheduler`, `InProcessEventBus`, `ValidatingEventBus`,
exported from `src/index.ts`.

## Quick start

```ts
import { RuntimeHost, InProcessScheduler, InProcessEventBus } from "@moolam/runtime";
import { createValidatingEventBus } from "@moolam/observability";

const host = new RuntimeHost();
host.register(myComponent);          // anything LifecycleAware
await host.start();

const bus = createValidatingEventBus(); // or new InProcessEventBus() for untyped tests
bus.subscribe("sync.outcome", (e) => console.log(e.type, e.payload.outcome));
```

## Contributing notes

- The scheduler stays minimal: deferred and periodic, nothing else. Cron grammars and distributed queues belong in hosts.
- No component may require that an event subscriber exists for correctness.
- New runtime features must answer: does the loop need this on a phone, a server, and a test runner alike?
- New EventBus domain types require a catalog schema + reference-doc update (see the event catalog link above) before publish is allowed.

## Examples

The runtime tests double as the conformance reference for writing a new host (a worker, a desktop app, an embedded controller).

## Tests

```bash
pnpm --filter @moolam/runtime test
```
