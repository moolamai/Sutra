// tool-use: the tool registry with risk classes. Reads and computations
// auto-execute; critical (irreversible/regulated) actions are denied
// unless an approval policy grants them. The policy lives with the host,
// not inside the tool.
import { randomUUID } from "node:crypto";

/** A ToolInterface with an execution policy over risk classes. */
function makeToolRegistry(approvalPolicy) {
  const tools = new Map([
    ["unit-convert", {
      descriptor: { name: "unit-convert", description: "Convert km to miles", parameters: { type: "object", properties: { km: { type: "number" } }, required: ["km"] }, riskClass: "compute" },
      run: (args) => args.km * 0.621371,
    }],
    ["file-filing", {
      descriptor: { name: "file-filing", description: "Submit a court filing (irreversible)", parameters: { type: "object", properties: { caseId: { type: "string" } }, required: ["caseId"] }, riskClass: "critical" },
      run: () => "filed",
    }],
  ]);

  return {
    list: () => [...tools.values()].map((t) => t.descriptor),
    invoke: async (invocation, deadlineMs) => {
      const started = Date.now();
      const tool = tools.get(invocation.toolName);
      if (!tool) return { invocationId: invocation.invocationId, status: "error", output: "unknown tool", latencyMs: 0 };

      // Argument validation against the descriptor schema (contract rule 1).
      for (const key of tool.descriptor.parameters.required ?? []) {
        if (!(key in invocation.arguments)) {
          return { invocationId: invocation.invocationId, status: "error", output: `missing argument '${key}'`, latencyMs: Date.now() - started };
        }
      }
      // Risk policy: write/critical need approval (contract rule 2 pairs this with write-ahead audit).
      const risk = tool.descriptor.riskClass;
      if ((risk === "write" || risk === "critical") && !approvalPolicy(invocation)) {
        return { invocationId: invocation.invocationId, status: "denied", output: `riskClass '${risk}' requires approval`, latencyMs: Date.now() - started };
      }
      const output = await Promise.race([
        Promise.resolve(tool.run(invocation.arguments)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("deadline")), deadlineMs)),
      ]);
      return { invocationId: invocation.invocationId, status: "ok", output, latencyMs: Date.now() - started };
    },
  };
}

const registry = makeToolRegistry(() => false); // no approvals granted in this demo

console.log("registered tools:", registry.list().map((d) => `${d.name} [${d.riskClass}]`).join(", "));

const compute = await registry.invoke({ toolName: "unit-convert", arguments: { km: 42 }, invocationId: randomUUID() }, 1000);
console.log("compute result :", compute.status, compute.output.toFixed(2), "miles");

const critical = await registry.invoke({ toolName: "file-filing", arguments: { caseId: "C-1" }, invocationId: randomUUID() }, 1000);
console.log("critical result:", critical.status, "-", critical.output);

const invalid = await registry.invoke({ toolName: "unit-convert", arguments: {}, invocationId: randomUUID() }, 1000);
console.log("invalid args   :", invalid.status, "-", invalid.output);

if (compute.status !== "ok" || critical.status !== "denied" || invalid.status !== "error") throw new Error("risk policy violated");
console.log("tool-use OK");
