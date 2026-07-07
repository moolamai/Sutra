# @moolam/runtime

Reference in-process implementations of the runtime contracts: the execution environment seams an agent needs from whatever hosts it. Phones, servers, and test harnesses implement the same four contracts; this package provides the plain, dependency-free versions that serve tests, examples, and simple deployments.

## Architecture

| File | Implements | Contract (from `@moolam/contracts`) |
|---|---|---|
| `src/lifecycle.ts` | `RuntimeHost` | `LifecycleAware` management with strict one-way transitions (suspend/resume excepted) |
| `src/scheduler.ts` | `InProcessScheduler` | `SchedulerInterface`: deferred and periodic tasks over plain timers |
| `src/events.ts` | `InProcessEventBus` | `EventBusInterface`: pub/sub for observations, never control flow |

Design philosophy lives in `design/runtime.md`; the decision record is ADR 0005.

## Public API

`RuntimeHost`, `InProcessScheduler`, `InProcessEventBus`, exported from `src/index.ts`.

## Quick start

```ts
import { RuntimeHost, InProcessScheduler, InProcessEventBus } from "@moolam/runtime";

const host = new RuntimeHost();
host.register(myComponent);          // anything LifecycleAware
await host.start();

const bus = new InProcessEventBus();
bus.subscribe("turn.completed", (e) => console.log(e));
```

## Contributing notes

- The scheduler stays minimal: deferred and periodic, nothing else. Cron grammars and distributed queues belong in hosts.
- No component may require that an event subscriber exists for correctness.
- New runtime features must answer: does the loop need this on a phone, a server, and a test runner alike?

## Examples

The runtime tests double as the conformance reference for writing a new host (a worker, a desktop app, an embedded controller).

## Tests

```bash
pnpm --filter @moolam/runtime test
```
