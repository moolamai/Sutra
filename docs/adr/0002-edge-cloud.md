# ADR 0002: Edge and cloud as peer runtimes

Status: Accepted

Date: 2026-07

## Context

The platform's founding deployment context is intermittent connectivity: rural schools, mobile clinics, field engineering. A cloud-primary architecture with an offline cache fails these users precisely when they need the system; an edge-only architecture forfeits larger models, cross-device continuity, and fleet-level insight.

## Decision

Edge and cloud are peers running the same cognitive loop. The edge host (`@moolam/edge-agent`) runs a quantized SLM and a local vector store and is fully functional with zero connectivity, indefinitely. The cloud engine runs larger models and the master memory graph. Neither defers to the other at decision time; their states converge afterwards through the sync protocol (ADR 0003).

## Options considered

- **Cloud-primary with offline queue**: turns become unavailable offline; the queue replays stale context. Rejected as failing the founding constraint.
- **Edge-only**: no cross-device continuity, no large-model escalation, no fleet view. Rejected.
- **Peers with convergent state (chosen)**: both act independently; CRDT merge makes eventual agreement a property rather than a protocol negotiation.

## Consequences

- The cognitive loop must be host-agnostic, which forced the contracts-first package structure and keeps it honest
- Guidance quality differs between hosts (SLM vs LLM); the state document records which replica produced each session register, and cloud wins LWW ties by design
- Every feature must answer "what does this do offline" at design time
- Model routing (when to prefer the cloud turn if connectivity exists) is deployment policy, not platform logic
