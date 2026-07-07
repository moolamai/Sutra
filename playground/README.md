# Playground

The developer instrument for the protocol: a Next.js console that drives the *production* packages (not mocks) interactively. Use it for rapid experimentation, protocol inspection, runtime testing, and demos.

What you can do in it:

- Submit simulated subject interactions and watch friction-weighted evidence move Bayesian mastery posteriors (CAST).
- Trigger the loop-back: fail a dependent concept with a weak prerequisite and watch the router route backwards (ATR).
- Take device replicas offline, diverge their state, then reconcile with a real CRDT merge and inspect the advisories (SYNC).

## Run it

```bash
pnpm install
pnpm --filter @moolam/playground dev   # http://localhost:3000
```

## Where the logic lives

- `app/console/engine.ts`: the in-browser twin of the routing and evidence-folding rules, importing `@moolam/sync-protocol` directly.
- `app/console/ProtocolConsole.tsx`: the console UI (light theme default, dark toggle).

Everything the console does runs through the same published packages an application would use. It demonstrates the product; it is not part of the product. The plain-language walkthrough is in [`docs/OVERVIEW.md`](../docs/OVERVIEW.md).
