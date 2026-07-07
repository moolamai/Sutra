/**
 * @module harness
 *
 * CognitiveCore - the composition root of the platform.
 *
 * An agent is not a model; it is a configuration of cognitive primitives.
 * The core accepts one implementation per contract, wires them into a
 * perceive - recall - retrieve - reason - act - reflect loop, and exposes
 * a single `turn()` to the host application. Swap any binding (pgvector
 * to graph store, cloud LLM to on-device SLM, cloud STT to Whisper.cpp)
 * and the loop is untouched: developers write domain configuration, not
 * cognitive machinery.
 */

import type {
  ChatMessage,
  KnowledgeConnectorInterface,
  MemoryInterface,
  ModelInterface,
  Plan,
  PlanningInterface,
  ReasoningInterface,
  SpeechInterface,
  ToolInterface,
  VisionInterface,
} from "@moolam/contracts";

/** One implementation per cognitive primitive. Speech/vision are optional - text-only agents are valid. */
export interface CognitiveBindings {
  memory: MemoryInterface;
  model: ModelInterface;
  reasoning: ReasoningInterface;
  planning: PlanningInterface;
  tools: ToolInterface;
  knowledge: KnowledgeConnectorInterface;
  speech?: SpeechInterface;
  vision?: VisionInterface;
}

/** Domain persona: the ONLY thing most integrators need to author. */
export interface AgentProfile {
  /** e.g. "clinical-support", "legal-research", "mathematics-mentor". */
  domainId: string;
  /** System framing prepended to every model call. */
  charter: string;
  /** Hard boundaries the agent must refuse to cross (scope of practice). */
  refusals: string[];
  /** Default language(s), BCP-47. */
  languages: string[];
}

export interface AgentTurnInput {
  subjectId: string;
  sessionId: string;
  utterance: string;
  /** Optional visual attachment routed through VisionInterface when bound. */
  attachment?: { data: Uint8Array; mimeType: string };
}

export interface AgentTurnOutput {
  reply: string;
  /** Citations from knowledge retrieval used in this turn. */
  citations: string[];
  /** The reasoning trace id persisted to memory for audit. */
  traceRef: string;
  /** Current plan snapshot, if a plan is active for this session. */
  plan: Plan | null;
}

/**
 * Reference composition. The loop is deliberately explicit and linear so
 * integrators can read it top-to-bottom; specialized deployments may
 * subclass or replace it while keeping the bindings contract.
 */
export class CognitiveCore {
  private readonly activePlans = new Map<string, Plan>();

  constructor(
    private readonly profile: AgentProfile,
    private readonly bindings: CognitiveBindings,
  ) {}

  /** One full cognitive turn: perceive - recall - retrieve - reason - respond - reflect. */
  async turn(input: AgentTurnInput): Promise<AgentTurnOutput> {
    const b = this.bindings;

    // 1. Perceive: fold visual input into the textual working context.
    let perception = input.utterance;
    if (input.attachment && b.vision) {
      const visual = await b.vision.analyze({
        input: input.attachment,
        instruction: `Describe this input in the context of: ${input.utterance}`,
      });
      perception += `\n[visual context] ${visual.answer}`;
    }

    // 2. Recall: what do we know about this principal?
    const memories = await b.memory.recall({
      subjectId: input.subjectId,
      query: perception,
      limit: 6,
    });

    // 3. Retrieve: what does the authoritative corpus say?
    const passages = await b.knowledge.retrieve({ query: perception, limit: 6 });

    // 4. Reason: deliberate over evidence with an auditable trace.
    const reasoning = await b.reasoning.deliberate({
      proposition: perception,
      evidence: [
        ...memories.map((m) => ({ sourceRef: `memory:${m.item.id}`, content: m.item.text })),
        ...passages.map((p) => ({ sourceRef: p.citation, content: p.content, confidence: p.score })),
      ],
      constraints: this.profile.refusals,
      effort: "standard",
    });

    // 5. Respond: generate the reply grounded in the reasoning conclusion.
    const messages: ChatMessage[] = [
      { role: "system", content: this.profile.charter },
      {
        role: "system",
        content: `Grounded conclusion (cite when used): ${reasoning.conclusion}`,
      },
      { role: "user", content: perception },
    ];
    const generation = await b.model.generate(messages, { deadlineMs: 30_000 });

    // 6. Reflect: persist the episode so the agent adapts long-term.
    const trace = await b.memory.remember({
      subjectId: input.subjectId,
      topicId: this.profile.domainId,
      text: `Q: ${input.utterance}\nConclusion: ${reasoning.conclusion}`,
      kind: "episodic",
      createdAt: new Date().toISOString(),
      metadata: { sessionId: input.sessionId, confidence: reasoning.confidence },
    });

    return {
      reply: generation.text,
      citations: passages.map((p) => p.citation),
      traceRef: trace.id,
      plan: this.activePlans.get(input.sessionId) ?? null,
    };
  }
}
