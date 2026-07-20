/**
 * Standalone `conformance` CLI entry.
 *
 * Human table or `--json`; accepts either the built-in self-check or an
 * external implementation factory module. The package owns the obligation
 * registry, deadlines, subject scoping, and verdict text — implementors supply
 * only fresh harness instances through the public factory contract.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  type Obligation,
} from "./registry.js";
import {
  buildRunReport,
  formatReport,
  type ConformanceRunReport,
  type ReportFormat,
  writeReport,
} from "./report.js";
import {
  DEFAULT_OBLIGATION_DEADLINE_MS,
  runConformance,
  type ConformanceRunnerEvent,
  type FactoryContext,
  type ImplementationFactory,
  type ImplementationTeardown,
} from "./runner.js";
import type { ConformanceObligationEvent } from "./registry.js";
import { createWireShapeRegistry } from "./obligations/wire.js";
import { createMemoryObligationsRegistry } from "./obligations/memory.js";
import { createReasoningObligationsRegistry } from "./obligations/reasoning.js";
import { createKnowledgeObligationsRegistry } from "./obligations/knowledge.js";
import { createToolObligationsRegistry } from "./obligations/tool.js";
import { createModelObligationsRegistry } from "./obligations/model.js";
import { createSpeechObligationsRegistry } from "./obligations/speech.js";
import { createVisionObligationsRegistry } from "./obligations/vision.js";
import { createPlanningObligationsRegistry } from "./obligations/planning.js";
import { createCastObligationsRegistry } from "./obligations/cast.js";
import { createRuntimeObligationsRegistry } from "./obligations/runtime.js";
import { createLocalityPolicyObligationsRegistry } from "./locality/harness.js";
import { createRefusalObligationsRegistry } from "./obligations/refusals.js";

export type CliIo = {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

export type ParsedCliArgs = {
  help: boolean;
  selfCheck: boolean;
  factorySpecifier: string | undefined;
  format: ReportFormat;
  subjectId: string | undefined;
  deviceId: string | undefined;
  deadlineMs: number;
  only: string[] | undefined;
  emitEvents: boolean;
  errors: string[];
};

const HELP = `Usage: conformance [options]

Contract-conformance runner for @moolam/contracts MUST obligations.

Options:
  --self-check          Run the built-in harness probe suite (CI / implementor smoke)
  --factory <module>    External ESM factory path or installed package specifier
  --json                Emit machine-readable JSON instead of the human table
  --subject-id <id>     Required synthetic subject scope (isolation)
  --device-id <id>      Optional device id for observability correlation
  --deadline-ms <n>     Per-obligation deadline (default ${DEFAULT_OBLIGATION_DEADLINE_MS})
  --only <id[,id...]>   Restrict to listed obligation ids
  --emit-events         Mirror structured events on stderr (never raw content)
  -h, --help            Show this help

Exit codes:
  0  all selected obligations passed
  1  any fail / timeout / error (or invalid CLI usage)

Factory module contract:
  export default async function factory({ subjectId, obligationId, signal }) {
    return aFreshHarnessFor(obligationId);
  }
  export async function teardown(harness, context) { ... } // optional
`;

export function parseConformanceArgv(argv: readonly string[]): ParsedCliArgs {
  const args: ParsedCliArgs = {
    help: false,
    selfCheck: false,
    factorySpecifier: undefined,
    format: "human",
    subjectId: undefined,
    deviceId: undefined,
    deadlineMs: DEFAULT_OBLIGATION_DEADLINE_MS,
    only: undefined,
    emitEvents: false,
    errors: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      args.help = true;
      continue;
    }
    if (a === "--self-check") {
      args.selfCheck = true;
      continue;
    }
    if (a === "--factory") {
      const v = argv[++i];
      if (!v) args.errors.push("--factory requires a module path or package specifier");
      else args.factorySpecifier = v;
      continue;
    }
    if (a === "--json") {
      args.format = "json";
      continue;
    }
    if (a === "--emit-events") {
      args.emitEvents = true;
      continue;
    }
    if (a === "--subject-id") {
      const v = argv[++i];
      if (!v) args.errors.push("--subject-id requires a value");
      else args.subjectId = v;
      continue;
    }
    if (a === "--device-id") {
      const v = argv[++i];
      if (!v) args.errors.push("--device-id requires a value");
      else args.deviceId = v;
      continue;
    }
    if (a === "--deadline-ms") {
      const v = argv[++i];
      const n = v === undefined ? Number.NaN : Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        args.errors.push("--deadline-ms requires a positive number");
      } else {
        args.deadlineMs = n;
      }
      continue;
    }
    if (a === "--only") {
      const v = argv[++i];
      if (!v) {
        args.errors.push("--only requires a comma-separated id list");
      } else {
        args.only = v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (args.only.length === 0) {
          args.errors.push("--only requires at least one obligation id");
        }
      }
      continue;
    }
    args.errors.push(`unknown argument: ${a}`);
  }

  if (args.selfCheck && args.factorySpecifier !== undefined) {
    args.errors.push("--self-check and --factory are mutually exclusive");
  }

  return args;
}

type ProbeStore = {
  remember(subjectId: string, value: string): Promise<void>;
  recall(subjectId: string): Promise<string | null>;
};

function goodProbeFactory(): ProbeStore {
  const bySubject = new Map<string, string>();
  return {
    async remember(subjectId, value) {
      bySubject.set(subjectId, value);
    },
    async recall(subjectId) {
      return bySubject.get(subjectId) ?? null;
    },
  };
}

function buildSelfCheckRegistry(): ObligationRegistry {
  const registry = new ObligationRegistry();
  const MUST_DURABLE = "`remember` MUST be durable before resolving.";
  const MUST_SUBJECT =
    "Implementations MUST be safe under concurrent subjects (multi-tenant).";

  registry.register(
    defineObligation<ProbeStore>({
      id: "CK-02.1",
      contract: "MemoryInterface",
      mustText: MUST_DURABLE,
      specIds: ["CK-02"],
      async check(impl, ctx) {
        await impl.remember(ctx.subjectId, "token-a");
        if ((await impl.recall(ctx.subjectId)) !== "token-a") {
          throw new ObligationViolation({
            obligationId: "CK-02.1",
            mustText: MUST_DURABLE,
            contract: "MemoryInterface",
            message: "remember did not persist before resolve",
          });
        }
      },
    }),
  );

  registry.register(
    defineObligation<ProbeStore>({
      id: "CK-02.3",
      contract: "MemoryInterface",
      mustText: MUST_SUBJECT,
      specIds: ["CK-02"],
      async check(impl, ctx) {
        const other = `${ctx.subjectId}::peer`;
        await impl.remember(ctx.subjectId, "mine");
        await impl.remember(other, "theirs");
        if ((await impl.recall(ctx.subjectId)) !== "mine") {
          throw new ObligationViolation({
            obligationId: "CK-02.3",
            mustText: MUST_SUBJECT,
            contract: "MemoryInterface",
            message: "subject-scoped recall lost own write",
          });
        }
        if ((await impl.recall(other)) !== "theirs") {
          throw new ObligationViolation({
            obligationId: "CK-02.3",
            mustText: MUST_SUBJECT,
            contract: "MemoryInterface",
            message: "cross-subject store leak or overwrite",
          });
        }
      },
    }),
  );

  return registry;
}

function mergeRegistry(
  target: ObligationRegistry,
  source: ObligationRegistry,
): ObligationRegistry {
  for (const obligation of source.list()) {
    target.register(obligation as Obligation<unknown>);
  }
  return target;
}

/**
 * Published executable catalog used for external implementations.
 * The runner owns these MUST clauses; a factory cannot replace or weaken them.
 */
export function buildExternalConformanceRegistry(): ObligationRegistry {
  const registry = new ObligationRegistry();
  const suites = [
    createWireShapeRegistry(),
    createMemoryObligationsRegistry(),
    createReasoningObligationsRegistry(),
    createKnowledgeObligationsRegistry(),
    createToolObligationsRegistry(),
    createModelObligationsRegistry(),
    createSpeechObligationsRegistry(),
    createVisionObligationsRegistry(),
    createPlanningObligationsRegistry(),
    createCastObligationsRegistry(),
    createRuntimeObligationsRegistry(),
    createLocalityPolicyObligationsRegistry(),
    createRefusalObligationsRegistry(),
  ];
  for (const suite of suites) mergeRegistry(registry, suite);
  return registry;
}

type ExternalFactoryObject = {
  factory: ImplementationFactory<unknown>;
  teardown?: ImplementationTeardown<unknown>;
};

type ExternalFactoryModule = {
  default?: ImplementationFactory<unknown> | ExternalFactoryObject;
  factory?: ImplementationFactory<unknown>;
  createConformanceImplementation?: ImplementationFactory<unknown>;
  teardown?: ImplementationTeardown<unknown>;
};

export class ExternalFactoryModuleError extends Error {
  readonly failureClass:
    | "module_load_timeout"
    | "module_load_error"
    | "factory_export_missing";

  constructor(
    failureClass: ExternalFactoryModuleError["failureClass"],
    message: string,
  ) {
    super(message);
    this.name = "ExternalFactoryModuleError";
    this.failureClass = failureClass;
  }
}

function importSpecifier(specifier: string): string {
  if (
    specifier.startsWith("file:") ||
    (!path.isAbsolute(specifier) &&
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("\\"))
  ) {
    return specifier;
  }
  return pathToFileURL(path.resolve(specifier)).href;
}

/**
 * Load a factory module within the same bounded deadline as one obligation.
 * Package specifiers resolve through normal Node ESM rules; relative paths
 * resolve from the caller's working directory, so no monorepo checkout is
 * required.
 */
export async function loadExternalFactoryModule(
  specifier: string,
  deadlineMs: number,
): Promise<ExternalFactoryObject> {
  const resolved = importSpecifier(specifier);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const loaded = await Promise.race([
      import(resolved) as Promise<ExternalFactoryModule>,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ExternalFactoryModuleError(
                "module_load_timeout",
                `factory module load exceeded ${deadlineMs}ms`,
              ),
            ),
          deadlineMs,
        );
      }),
    ]);

    const defaultObject =
      typeof loaded.default === "object" && loaded.default !== null
        ? loaded.default
        : undefined;
    const factory =
      typeof loaded.default === "function"
        ? loaded.default
        : defaultObject?.factory ??
          loaded.factory ??
          loaded.createConformanceImplementation;
    const teardown = defaultObject?.teardown ?? loaded.teardown;

    if (typeof factory !== "function") {
      throw new ExternalFactoryModuleError(
        "factory_export_missing",
        "module must export a default factory, factory, or createConformanceImplementation function",
      );
    }
    return {
      factory,
      ...(typeof teardown === "function" ? { teardown } : {}),
    };
  } catch (error) {
    if (error instanceof ExternalFactoryModuleError) throw error;
    throw new ExternalFactoryModuleError(
      "module_load_error",
      "factory module could not be loaded",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Unexpected implementation exceptions may contain user data. External CLI
 * reports retain attribution and failure class but replace those messages with
 * stable metadata-only text. Obligation violations remain harness-authored.
 */
export function redactExternalImplementationErrors(
  report: ConformanceRunReport,
): ConformanceRunReport {
  return buildRunReport(
    report.verdicts.map((verdict) => {
      if (verdict.attribution !== "implementation") {
        return verdict;
      }
      const message = verdict.message ?? "";
      if (message.includes("teardown failed:")) {
        return { ...verdict, message: "implementation teardown failed" };
      }
      if (verdict.outcome !== "error") return verdict;
      const safeMessage = message.startsWith("setup failed:")
        ? "implementation factory setup failed"
        : "implementation check raised an unexpected error";
      return { ...verdict, message: safeMessage };
    }),
  );
}

function emitFactoryEvent(
  io: CliIo,
  enabled: boolean,
  event: {
    outcome: "loaded" | "error";
    subjectId: string;
    deviceId?: string;
    failureClass?: ExternalFactoryModuleError["failureClass"];
  },
): void {
  if (!enabled) return;
  io.stderr.write(
    `${JSON.stringify({ event: "conformance.factory", ...event })}\n`,
  );
}

/**
 * Programmatic CLI entry. Returns the process exit code (does not call exit).
 */
export async function runConformanceCli(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  const parsed = parseConformanceArgv(argv);

  if (parsed.help) {
    io.stdout.write(HELP);
    return 0;
  }

  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      io.stderr.write(`conformance: ${err}\n`);
    }
    io.stderr.write(HELP);
    return 1;
  }

  if (!parsed.selfCheck && parsed.factorySpecifier === undefined) {
    io.stderr.write(
      "conformance: specify exactly one of --self-check or --factory <module>\n",
    );
    io.stderr.write(HELP);
    return 1;
  }

  const subjectId = parsed.subjectId?.trim();
  if (!subjectId) {
    io.stderr.write(
      "conformance: --subject-id is required (subject isolation)\n",
    );
    return 1;
  }

  let registry: ObligationRegistry;
  let factory: ImplementationFactory<unknown>;
  let teardown: ImplementationTeardown<unknown> | undefined;

  if (parsed.selfCheck) {
    registry = buildSelfCheckRegistry();
    factory = () => goodProbeFactory();
  } else {
    registry = buildExternalConformanceRegistry();
    try {
      const external = await loadExternalFactoryModule(
        parsed.factorySpecifier!,
        parsed.deadlineMs,
      );
      factory = external.factory;
      teardown = external.teardown;
      emitFactoryEvent(io, parsed.emitEvents, {
        outcome: "loaded",
        subjectId,
        ...(parsed.deviceId !== undefined ? { deviceId: parsed.deviceId } : {}),
      });
    } catch (error) {
      const typed =
        error instanceof ExternalFactoryModuleError
          ? error
          : new ExternalFactoryModuleError(
              "module_load_error",
              "factory module could not be loaded",
            );
      emitFactoryEvent(io, parsed.emitEvents, {
        outcome: "error",
        subjectId,
        ...(parsed.deviceId !== undefined ? { deviceId: parsed.deviceId } : {}),
        failureClass: typed.failureClass,
      });
      io.stderr.write(
        `conformance: factory load failed [${typed.failureClass}]\n`,
      );
      return 1;
    }
  }

  const emit = parsed.emitEvents
    ? (event: ConformanceObligationEvent | ConformanceRunnerEvent) => {
        io.stderr.write(`${JSON.stringify(event)}\n`);
      }
    : undefined;

  const report = await runConformance({
    registry,
    factory,
    subjectId,
    ...(parsed.deviceId !== undefined ? { deviceId: parsed.deviceId } : {}),
    ...(parsed.only !== undefined ? { obligationIds: parsed.only } : {}),
    deadlineMs: parsed.deadlineMs,
    ...(teardown !== undefined ? { teardown } : {}),
    ...(emit !== undefined ? { emit } : {}),
  });

  const safeReport = parsed.selfCheck
    ? report
    : redactExternalImplementationErrors(report);
  writeReport(safeReport, { format: parsed.format, stdout: io.stdout });
  return safeReport.exitCode;
}

/** Convenience for bins / tests that only need formatting after a run. */
export { formatReport, writeReport };
