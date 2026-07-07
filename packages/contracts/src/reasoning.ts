/**
 * @module reasoning
 *
 * Reasoning contract - structured deliberation over evidence.
 *
 * The core separates *reasoning* (deriving conclusions with an auditable
 * trace) from raw generation. Implementations range from single-model
 * chain-of-thought, to multi-step verifier loops, to symbolic/neural
 * hybrids (e.g. a legal-rule engine checking model output). Domains with
 * professional liability (law, medicine, finance) demand the trace — it is
 * not optional decoration.
 */

export interface EvidenceItem {
  /** Where this evidence came from: memory id, knowledge-connector citation, tool result id. */
  sourceRef: string;
  content: string;
  /** Implementation-defined confidence in [0,1]. */
  confidence?: number;
}

export interface ReasoningRequest {
  /** The question/decision under deliberation. */
  proposition: string;
  evidence: EvidenceItem[];
  /** Domain constraints the conclusion must respect (statutes, contraindications, risk limits…). */
  constraints?: string[];
  /** Depth budget: implementations map this to steps/self-checks. */
  effort?: "fast" | "standard" | "thorough";
}

export interface ReasoningStep {
  kind: "inference" | "verification" | "counterargument" | "assumption";
  statement: string;
  /** Which evidence items this step relies on (indices into the request). */
  evidenceRefs: number[];
}

export interface ReasoningResult {
  conclusion: string;
  confidence: number;
  /** The auditable trace. MUST be complete enough to reconstruct the conclusion. */
  steps: ReasoningStep[];
  /** Constraints the engine could NOT satisfy or verify — never silently dropped. */
  unresolvedConstraints: string[];
}

/**
 * Contract requirements:
 *  1. Every conclusion MUST carry its trace; an empty `steps` array is a
 *     contract violation, not a valid fast path.
 *  2. Unverifiable constraints go to `unresolvedConstraints` — the engine
 *     never pretends to have checked what it has not.
 */
export interface ReasoningInterface {
  deliberate(request: ReasoningRequest): Promise<ReasoningResult>;
}
