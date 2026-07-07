# ADR 0005: Runtime as contracts with in-process reference implementations

Status: Accepted

Date: 2026-07

## Context

The same cognitive loop must run inside a phone app, a browser, a server process, and a test harness. Each environment differs in persistence, scheduling, and event delivery. Baking any one environment's assumptions into the core (filesystem access, long-lived timers, a specific framework) would fork the loop per host, which is the failure mode the platform exists to avoid.

## Decision

The runtime is defined as four small contracts in `@moolam/contracts` (lifecycle, scheduler, event bus, storage driver), and `@moolam/runtime` ships plain in-process reference implementations with no framework dependencies. Hosts provide their own implementations where the environment demands it; the reference ones serve tests, examples, and simple deployments.

## Options considered

- **Adopt an actor framework or workflow engine**: powerful scheduling and supervision, but imports a worldview and a dependency tree into every host, including phones. Rejected under the no-unnecessary-complexity rule.
- **Let each host improvise**: no contracts, each host wires its own timers and events. Rejected; this is how the loop forks per environment.
- **Contracts plus reference implementations (chosen)**: the seam is small enough to implement in an afternoon for a new host, and the reference implementations double as executable documentation.

## Consequences

- `cognitive-core` stays free of environment assumptions; its tests run against the reference runtime unchanged
- Lifecycle is deliberately strict (one-way transitions except suspend/resume, no partial startup), which surfaces initialization bugs at the boundary instead of mid-session
- The scheduler contract is minimal (deferred and periodic tasks); anything fancier (cron expressions, distributed queues) belongs in a host, not the contract
- Suspension semantics exist specifically for mobile hosts and cost every other host nothing
