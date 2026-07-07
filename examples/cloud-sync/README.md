# cloud-sync

Two device replicas accumulate different evidence while offline, then reconcile through the production `CrdtHarnessResolver`. The example asserts commutativity (merge order cannot change the converged state) and lossless friction union.

```bash
pnpm cloud-sync
```
