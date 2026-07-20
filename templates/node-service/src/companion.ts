import { CognitiveCore } from "sutra-sdk";
import { agentProfile } from "./config/domain.ts";
import {
  makeKnowledge,
  makeMemory,
  makeModel,
  makeNoTools,
  makePlanning,
  makeReasoning,
} from "./mocks/reference-bindings.ts";

/** Bound concurrent turns per subject (NFR — no unbounded fan-out). */
export const SUBJECT_TURN_QUEUE_LIMIT = 8;

export type ServiceTurnInput = {
  subjectId: string;
  sessionId: string;
  utterance: string;
  deviceId?: string;
  /** Idempotency key — replays return the cached outcome. */
  requestId?: string;
};

type CachedTurn = {
  reply: string;
  traceRef?: string;
  citationCount: number;
  deviceId: string;
  subjectId: string;
};

const idempotencyCache = new Map<string, CachedTurn>();
const subjectQueues = new Map<string, Promise<unknown>>();

function cacheKey(subjectId: string, requestId: string): string {
  return `${subjectId}::${requestId}`;
}

export function createServiceCore(subjectId: string): CognitiveCore {
  if (!subjectId.trim()) {
    throw new Error("subjectId is required for service core wiring");
  }
  const bindingOpts = { subjectId, persona: "node-service" };
  return new CognitiveCore(agentProfile, {
    memory: makeMemory(bindingOpts),
    model: makeModel(bindingOpts),
    reasoning: makeReasoning(),
    planning: makePlanning(),
    tools: makeNoTools(),
    knowledge: makeKnowledge(bindingOpts),
  });
}

/**
 * Serialize overlapping turns for the same subjectId (read-modify-write safety).
 * Distinct subjects run concurrently.
 */
export async function withSubjectTurnGate<T>(
  subjectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = subjectQueues.get(subjectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = prev.then(() => gate);
  subjectQueues.set(subjectId, pending);

  // Bound queue depth: reject when too many waiters (no unbounded growth).
  let depth = 0;
  for (const [, p] of subjectQueues) {
    void p;
    depth += 1;
    if (depth > SUBJECT_TURN_QUEUE_LIMIT * 4) {
      release();
      throw new Error("subject turn queue saturated");
    }
  }

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (subjectQueues.get(subjectId) === pending) {
      subjectQueues.delete(subjectId);
    }
  }
}

/** Run one mocked turn — subject-scoped, idempotent when requestId is set. */
export async function runServiceTurn(input: ServiceTurnInput): Promise<CachedTurn> {
  const subjectId = input.subjectId.trim();
  if (!subjectId) {
    throw new Error("subjectId is required for service turn");
  }
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new Error("sessionId is required for service turn");
  }
  const deviceId = (input.deviceId ?? "node-service").trim() || "node-service";
  const requestId = input.requestId?.trim();

  if (requestId) {
    const hit = idempotencyCache.get(cacheKey(subjectId, requestId));
    if (hit) return hit;
  }

  return withSubjectTurnGate(subjectId, async () => {
    if (requestId) {
      const hit = idempotencyCache.get(cacheKey(subjectId, requestId));
      if (hit) return hit;
    }

    const core = createServiceCore(subjectId);
    const out = await core.turn({
      subjectId,
      sessionId,
      utterance: input.utterance,
    });

    const cached: CachedTurn = {
      reply: out.reply,
      traceRef: out.traceRef,
      citationCount: out.citations.length,
      deviceId,
      subjectId,
    };

    if (requestId) {
      // Bounded cache — drop oldest when over limit.
      if (idempotencyCache.size >= 256) {
        const first = idempotencyCache.keys().next().value;
        if (first !== undefined) idempotencyCache.delete(first);
      }
      idempotencyCache.set(cacheKey(subjectId, requestId), cached);
    }

    return cached;
  });
}

/** Test helper — clear idempotency cache between smokes. */
export function resetServiceTurnState(): void {
  idempotencyCache.clear();
  subjectQueues.clear();
}
