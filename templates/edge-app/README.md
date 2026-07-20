# Sutra edge-app integration template

Expo / React Native starting point: subject-scoped `StorageDriver` seam, CognitiveCore wired with reference mocks, and a Node smoke path that typechecks without a monorepo checkout.

## What you get

| Path | Role |
|------|------|
| `App.tsx` | Expo/RN entry — one-button mock turn |
| `src/bindings/storage.ts` | `StorageDriver` (memory for smoke; expo-sqlite stub for device) |
| `src/mocks/reference-bindings.ts` | B2-style reference mocks |
| `src/companion.ts` | `bootstrapEdge` / `runEdgeTurn` |
| `scripts/smoke.ts` | Node install → typecheck → smoke |

## Quickstart (Node only)

```bash
pnpm install
pnpm typecheck
pnpm smoke
```

Smoke emits structured `integration_templates.edge_app.smoke` events with `subjectId`, `deviceId`, and outcome — never raw utterance content.

## Expo device host

1. Install optional peers: `expo`, `react`, `react-native`, `expo-sqlite`.
2. Replace `storageBackend: "memory"` with `"expo-sqlite"` after implementing the stub.
3. Launch with your Expo toolchain (`npx expo start`).

## Sovereignty

- Every storage key is namespaced by `subjectId`.
- Cross-subject queries return empty; empty `subjectId` is rejected at bootstrap.
- Locality stays `on-device` for the mock model descriptor.
