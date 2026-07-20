/**
 * @moolam/cognitive-core - the cognitive core.
 *
 * Domain-agnostic composition of the cognitive primitives into one
 * agent loop. The core contains no domain logic, no prompts beyond the
 * caller-supplied charter, and no vendor imports: bind any memory store,
 * any model, any reasoning engine, any speech or vision stack, any tools,
 * any planner, any knowledge source.
 *
 * The domain changes; the cognitive primitives stay the same.
 */

export * from "./harness.js";
export {
  PLAN_STAGE_GOAL_LIMIT,
  PLAN_STAGE_LOW_CONFIDENCE,
  PLAN_STAGE_OBLIGATION_RATIONALE,
  PlanStageError,
  SessionPlanGate,
  defaultSessionGoals,
  derivePlanRevisionSignal,
  planStageContext,
  runPlanStage,
  type PlanStageEvent,
  type PlanStageInput,
  type PlanStageOutcome,
  type PlanStageResult,
} from "./plan_stage.js";
export {
  ACT_STAGE_MAX_ITERATIONS,
  ACT_STAGE_TOOL_CALL_LIMIT,
  ACT_STAGE_TOOL_DEADLINE_MS,
  ACT_STAGE_OBLIGATION_MAX_ITERATIONS,
  ACT_STAGE_OBLIGATION_ENVELOPE,
  ToolStageError,
  defaultToolInvokeHook,
  formatToolCallFence,
  parseToolCallEnvelope,
  parseToolCallEntry,
  runActStage,
  type ToolCallEnvelopeEntry,
  type ToolInvokeHook,
  type ToolStageEvent,
  type ToolStageInput,
  type ToolStageOutcome,
  type ToolStageResult,
} from "./tool_stage.js";
export {
  RISK_CLASS_ROUTING,
  TOOL_POLICY_MUST_WRITE,
  TOOL_POLICY_MUST_CRITICAL,
  TOOL_POLICY_OBLIGATION_HOOK_MISSING,
  TOOL_POLICY_OBLIGATION_APPROVAL_TIMEOUT,
  TOOL_POLICY_OBLIGATION_RISK_ASSUMED_WRITE,
  TOOL_POLICY_LIST_SCAN_LIMIT,
  ToolPolicyError,
  authorizeToolInvocation,
  createToolPolicy,
  defaultDenyToolPolicyHooks,
  defaultPolicyInnerInvoke,
  invokeThroughToolPolicy,
  lookupToolDescriptor,
  policyDenialAsModelToolError,
  resolveRiskClass,
  routeForRiskClass,
  type AuthorizeToolInput,
  type InvokeThroughToolPolicyInput,
  type PolicyInnerInvoke,
  type ToolPolicy,
  type ToolPolicyAuthorization,
  type ToolPolicyContext,
  type ToolPolicyEvent,
  type ToolPolicyEventOutcome,
  type ToolPolicyHooks,
  type ToolPolicyRoute,
  type ToolPolicyRouteMode,
  type ToolRiskClass,
} from "./tool_policy.js";
export {
  TOOL_AUDIT_MUST_WRITE_AHEAD,
  TOOL_AUDIT_OBLIGATION_WRITE_AHEAD,
  TOOL_AUDIT_OBLIGATION_SINK_REQUIRED,
  TOOL_AUDIT_OBLIGATION_SINK_TIMEOUT,
  TOOL_AUDIT_RECORD_LIMIT,
  ToolAuditError,
  createInMemoryAuditSink,
  hashToolArguments,
  recordThenInvoke,
  requiresWriteAheadAudit,
  assertAuditBeforeEffect,
  type AuditSink,
  type ToolAuditEntry,
  type ToolAuditEvent,
  type ToolAuditOutcome,
  type ToolAuditPhase,
  type ToolAuditRecordInvocationInput,
  type WriteAheadInvokeInput,
} from "./tool_audit.js";
