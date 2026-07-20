# Sutra node-service integration template

HTTP host with CognitiveCore and B2-style reference mocks. Uses Node's built-in `http` module so install → typecheck → smoke works with only Node; swap the listener for Express/Fastify without changing turn wiring.

## Quickstart

```bash
pnpm install
pnpm typecheck
pnpm smoke
pnpm start   # listens on :8787 — POST /v1/turn
```

## Routes

| Method | Path | Notes |
|--------|------|-------|
| GET | `/v1/health` | readiness |
| POST | `/v1/turn` | `{ subjectId, sessionId, utterance, deviceId?, requestId? }` |

Responses never echo raw utterance content — only metadata (`replyLength`, `traceRef`, `subjectId`, `deviceId`).

## Sovereignty

- Empty `subjectId` rejected at the boundary.
- Per-subject turn serialization (no cross-subject RMW races).
- `requestId` replays are idempotent (cached outcome).
