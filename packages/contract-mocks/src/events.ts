/**
 * Structured mock observability — never includes raw learner / patient content.
 *
 * @module events
 */

export type MockOutcome = "ok" | "error";

export type ContractMockEvent =
  | {
      event: "contract_mocks.memory";
      op: "remember" | "recall" | "associate" | "forget" | "compact";
      subjectId: string;
      deviceId: string;
      outcome: MockOutcome;
      itemCount?: number;
    }
  | {
      event: "contract_mocks.model";
      op: "generate" | "generateStream" | "embed";
      subjectId: string;
      deviceId: string;
      outcome: MockOutcome;
      locality: "on-device" | "self-hosted" | "external-api";
    }
  | {
      event: "contract_mocks.reasoning";
      op: "deliberate";
      subjectId: string;
      deviceId: string;
      outcome: MockOutcome;
      stepCount: number;
      unresolvedCount: number;
    }
  | {
      event: "contract_mocks.knowledge";
      op: "retrieve";
      subjectId: string;
      deviceId: string;
      outcome: MockOutcome;
      passageCount: number;
    }
  | {
      event: "contract_mocks.tool";
      op: "invoke" | "list";
      subjectId: string;
      deviceId: string;
      outcome: MockOutcome;
      toolName?: string;
      riskClass?: string;
    }
  | {
      event: "contract_mocks.planning";
      op: "compose" | "revise" | "nextStep";
      subjectId: string;
      deviceId: string;
      outcome: MockOutcome;
      stepCount?: number;
    }
  | {
      event: "contract_mocks.speech";
      op: "transcribe" | "synthesize";
      subjectId: string;
      deviceId: string;
      outcome: MockOutcome;
      segmentCount?: number;
      language?: string;
    }
  | {
      event: "contract_mocks.vision";
      op: "analyze";
      subjectId: string;
      deviceId: string;
      outcome: MockOutcome;
      bytes?: number;
    }
  | {
      event: "contract_mocks.runtime";
      op: "initialize" | "dispose" | "schedule" | "publish" | "execute";
      subjectId: string;
      deviceId: string;
      outcome: MockOutcome;
    };

export type ContractMockEmit = (event: ContractMockEvent) => void;
