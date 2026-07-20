/** Ambient types for playground route_core.mjs (imported from engine.ts). */
declare module "./route_core.mjs" {
  export const HESITATION_SPIKE_MS: number;
  export const MAX_REMEDIATION_DEPTH: number;

  export function masteryMean(
    state: {
      mastery: Record<
        string,
        { alpha: Record<string, number>; beta: Record<string, number> }
      >;
    },
    conceptId: string,
  ): number;

  export function evidenceCount(
    state: {
      mastery: Record<
        string,
        { alpha: Record<string, number>; beta: Record<string, number> }
      >;
    },
    conceptId: string,
  ): number;

  export function routeTurnOnGraph(
    graph: {
      nodes:
        | Map<string, { conceptId: string; title?: string; prerequisites: string[] }>
        | Record<string, { conceptId: string; title?: string; prerequisites: string[] }>;
      advanceThreshold: number;
      remediateThreshold: number;
      hesitationSpikeMs?: number;
      maxRemediationDepth?: number;
      orderedConcepts?: { conceptId: string; title?: string; prerequisites: string[] }[];
    },
    state: {
      mode: string;
      mastery: Record<
        string,
        { alpha: Record<string, number>; beta: Record<string, number> }
      >;
    },
    sample: {
      conceptId: string;
      hesitationMs: number;
      revisionCount: number;
      assistanceRequested: boolean;
      outcome: string;
    },
  ): { nextConceptId: string; mode: string; rationale: string[] };
}
