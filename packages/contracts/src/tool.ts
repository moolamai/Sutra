/**
 * @module tool
 *
 * Tool contract - how the agent acts on the world.
 *
 * Calculators, court-filing search, drug-interaction checkers, market-data
 * feeds, CAD validators, code runners - all registered behind one schema'd
 * contract. Tools are the highest-risk surface of an agent, so the
 * contract bakes in permissioning and audit rather than leaving them to
 * each deployment's discipline.
 */

export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /**
   * Risk class drives the runtime's execution policy:
   *  - "read"    : pure lookup, auto-executable
   *  - "compute" : side-effect-free computation, auto-executable
   *  - "write"   : mutates external state, requires policy approval
   *  - "critical": irreversible/regulated action, requires human approval
   */
  riskClass: "read" | "compute" | "write" | "critical";
}

export interface ToolInvocation {
  toolName: string;
  arguments: Record<string, unknown>;
  /** Correlation id propagated into the audit log. */
  invocationId: string;
}

export interface ToolResult {
  invocationId: string;
  status: "ok" | "error" | "denied";
  /** JSON-serializable output or a structured error report. */
  output: unknown;
  latencyMs: number;
}

/**
 * Contract requirements:
 *  1. `invoke` MUST validate arguments against the descriptor schema and
 *     return status "error" (not throw) on violation.
 *  2. "write"/"critical" invocations MUST be recorded to the audit sink
 *     before execution begins (write-ahead audit).
 *  3. Implementations MUST enforce the deadline; a hung tool cannot hang
 *     the agent.
 */
export interface ToolInterface {
  list(): ToolDescriptor[];
  invoke(invocation: ToolInvocation, deadlineMs: number): Promise<ToolResult>;
}
