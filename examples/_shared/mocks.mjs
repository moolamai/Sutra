// Deterministic mock bindings shared by the examples. Each mock is a
// legitimate minimal implementation of its contract: durable-before-resolve
// memory, trace-bearing reasoning, citation-bearing knowledge.

/** Deterministic 8-dim embedding: character histogram buckets, L2-normalized. */
export function embed(text) {
  const v = new Float32Array(8);
  for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % 8] += 1;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** In-memory MemoryInterface. */
export function makeMemory() {
  const items = [];
  return {
    remember: async (item) => {
      const stored = { ...item, id: `mem-${items.length + 1}` };
      items.push(stored); // synchronous append = durable for an in-process store
      return stored;
    },
    recall: async (query) => {
      const q = embed(query.query);
      return items
        .filter((i) => i.subjectId === query.subjectId)
        .map((item) => {
          const e = embed(item.text);
          let score = 0;
          for (let i = 0; i < 8; i++) score += q[i] * e[i];
          return { item, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, query.limit ?? 8);
    },
    associate: async () => {},
    forget: async () => {},
    compact: async () => 0,
    _items: items,
  };
}

/** Echo-style ModelInterface: replies deterministically from the last user message. */
export function makeModel(persona) {
  return {
    descriptor: { modelId: "mock-slm", contextWindow: 8192, locality: "on-device", modalities: ["text"] },
    generate: async (messages) => {
      const user = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
      const grounding = messages.find((m) => m.content.startsWith("Grounded conclusion"))?.content ?? "";
      return {
        text: `[${persona}] ${grounding ? grounding.replace("Grounded conclusion (cite when used): ", "") + " " : ""}(re: ${user.slice(0, 60)})`,
        finishReason: "stop",
      };
    },
    generateStream: async function* (messages) {
      yield (await this.generate(messages)).text;
    },
    embed: async (text) => embed(text),
  };
}

/** ReasoningInterface with a real (small) trace per the contract. */
export function makeReasoning() {
  return {
    deliberate: async (request) => ({
      conclusion: request.evidence.length
        ? `Based on ${request.evidence.length} evidence item(s): ${request.evidence[0].content.slice(0, 80)}`
        : "No evidence retrieved; answering from general knowledge with low confidence.",
      confidence: request.evidence.length ? 0.8 : 0.3,
      steps: [
        { kind: "assumption", statement: `Proposition: ${request.proposition.slice(0, 80)}`, evidenceRefs: [] },
        ...request.evidence.slice(0, 3).map((e, i) => ({
          kind: "inference",
          statement: `Weighed evidence from ${e.sourceRef}`,
          evidenceRefs: [i],
        })),
      ],
      unresolvedConstraints: [],
    }),
  };
}

/** Citation-bearing KnowledgeConnectorInterface over a tiny in-memory corpus. */
export function makeKnowledge(sourceId, passages) {
  return {
    sources: [
      {
        sourceId,
        title: sourceId,
        domain: sourceId,
        locality: "bundled-offline",
        coverage: { from: "2020-01-01", to: "2026-01-01" },
      },
    ],
    retrieve: async (query) => {
      const q = embed(query.query);
      return passages
        .map((p, i) => {
          const e = embed(p.content);
          let score = 0;
          for (let j = 0; j < 8; j++) score += q[j] * e[j];
          return { sourceId, citation: `${sourceId}#${i + 1}`, content: p.content, score, asOf: p.asOf };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, query.limit ?? 4);
    },
  };
}

/** Minimal PlanningInterface. */
export function makePlanning() {
  return {
    compose: async (goals, context) => ({
      planId: "plan-1",
      steps: goals.map((g, i) => ({
        stepId: `s${i + 1}`,
        goalId: g.goalId,
        action: `Work toward: ${g.description}`,
        dependsOn: i > 0 ? [`s${i}`] : [],
        status: i === 0 ? "active" : "pending",
      })),
      rationale: `Ordered by prerequisites for context: ${context}`,
    }),
    revise: async (plan, event) => ({ ...plan, rationale: `${plan.rationale} | revised: ${event.observation}` }),
    nextStep: (plan) => plan.steps.find((s) => s.status === "active") ?? null,
  };
}

/** Empty ToolInterface for examples that do not exercise tools. */
export function makeNoTools() {
  return {
    list: () => [],
    invoke: async (invocation) => ({ invocationId: invocation.invocationId, status: "error", output: "no tools registered", latencyMs: 0 }),
  };
}
