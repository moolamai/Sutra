/**
 * @moolam/contract-mocks — typed in-memory reference floor for @moolam/contracts.
 *
 * Memory, model, reasoning.
 * Knowledge, tool, planning.
 * Speech, vision, runtime.
 *
 * Runtime dependency: @moolam/contracts only (CK-01).
 */

export {
  REFERENCE_EMBED_DIM,
  cosineLike,
  embedText,
} from "./embed.js";

/** examples/_shared alias for {@link embedText}. */
export { embedText as embed } from "./embed.js";
export type { ContractMockEmit, ContractMockEvent, MockOutcome } from "./events.js";

export {
  EPISODIC_HALF_LIFE_MS,
  MEMORY_RECALL_LIMIT,
  MEMORY_SCAN_LIMIT,
  createMemoryDurableStore,
  createMemoryMock,
  createMemoryMockHarnessFactory,
  kindAwareDecayFactor,
  makeMemory,
  parseCreatedAtMs,
} from "./memory.js";
export type {
  MemoryDurableStore,
  MemoryMockClock,
  MemoryMockHarness,
  MemoryMockOptions,
} from "./memory.js";

export {
  createModelMock,
  createModelMockHarnessFactory,
  makeModel,
} from "./model.js";
export type { ModelMockHarness, ModelMockOptions } from "./model.js";

export {
  REASONING_CONSTRAINT_LIMIT,
  REASONING_STEP_LIMIT,
  createReasoningMock,
  createReasoningMockHarnessFactory,
  makeReasoning,
} from "./reasoning.js";
export type { ReasoningMockHarness, ReasoningMockOptions } from "./reasoning.js";

export {
  DEFAULT_KNOWLEDGE_AS_OF,
  DEFAULT_KNOWLEDGE_SOURCE_ID,
  KNOWLEDGE_PASSAGE_LIMIT,
  createKnowledgeMock,
  createKnowledgeMockHarnessFactory,
  makeKnowledge,
} from "./knowledge.js";
export type {
  KnowledgeMockHarness,
  KnowledgeMockOptions,
  KnowledgePassageSeed,
} from "./knowledge.js";

export {
  TOOL_AUDIT_SCAN_LIMIT,
  TOOL_DESCRIPTOR_LIMIT,
  TOOL_PROBE_HANG,
  TOOL_PROBE_READ,
  TOOL_PROBE_VALIDATE,
  TOOL_PROBE_WRITE,
  createToolAuditSink,
  createToolMock,
  createToolMockHarnessFactory,
  makeNoTools,
  makeTools,
  referenceToolDescriptors,
} from "./tool.js";
export type {
  ToolAuditPhase,
  ToolAuditRecord,
  ToolAuditSink,
  ToolMockHarness,
  ToolMockOptions,
} from "./tool.js";

export {
  PLANNING_STEP_LIMIT,
  createPlanningMock,
  createPlanningMockHarnessFactory,
  makePlanning,
} from "./planning.js";
export type { PlanningMockHarness, PlanningMockOptions } from "./planning.js";

export {
  SPEECH_SAMPLE_RATE_HZ,
  SPEECH_STREAM_CHUNK_LIMIT,
  createSpeechMock,
  createSpeechMockHarnessFactory,
  makeSpeech,
} from "./speech.js";
export type { SpeechMockHarness, SpeechMockOptions } from "./speech.js";

export {
  VISION_REFERENCE_MAX_INPUT_BYTES,
  VISION_SCHEMA_KEY_SCAN_LIMIT,
  createVisionMock,
  createVisionMockHarnessFactory,
  createVisionSizeLimitError,
  makeVision,
} from "./vision.js";
export type { VisionMockHarness, VisionMockOptions } from "./vision.js";

export {
  RUNTIME_SCAN_LIMIT,
  RUNTIME_SUBSCRIBER_ERROR_TYPE,
  createEventBusMock,
  createLifecycleMock,
  createMemoryStorageDriver,
  createRuntimeMock,
  createRuntimeMockHarnessFactory,
  createSchedulerMock,
} from "./runtime.js";
export type { RuntimeMockHarness, RuntimeMockOptions } from "./runtime.js";
