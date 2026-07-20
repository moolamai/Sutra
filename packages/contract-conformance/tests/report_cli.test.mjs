/**
 * Verdict reporter + CLI .
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildRunReport,
  formatHumanReport,
  formatJsonReport,
  parseConformanceArgv,
  runConformance,
  runConformanceCli,
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "../bin/conformance.mjs");
const DIST_URL = pathToFileURL(path.join(__dirname, "../dist/index.js")).href;

function memoryCapture() {
  let out = "";
  let err = "";
  return {
    stdout: {
      write(chunk) {
        out += chunk;
      },
      text: () => out,
    },
    stderr: {
      write(chunk) {
        err += chunk;
      },
      text: () => err,
    },
  };
}

async function withExternalFactory(source, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "moolam-conformance-cli-"));
  const factoryPath = path.join(dir, "factory.mjs");
  await writeFile(factoryPath, source, "utf8");
  try {
    return await run(factoryPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("human report lists MUST text on failure", () => {
  const report = buildRunReport([
    {
      obligationId: "CK-02.1",
      contract: "MemoryInterface",
      mustText: "`remember` MUST be durable before resolving.",
      outcome: "pass",
      attribution: "implementation",
      durationMs: 3,
      subjectId: "s::CK-02.1",
    },
    {
      obligationId: "CK-02.3",
      contract: "MemoryInterface",
      mustText: "Implementations MUST be safe under concurrent subjects (multi-tenant).",
      outcome: "fail",
      attribution: "implementation",
      durationMs: 5,
      subjectId: "s::CK-02.3",
      message: "cross-subject store leak or overwrite",
    },
  ]);
  const human = formatHumanReport(report);
  assert.match(human, /PASS\s+CK-02\.1/);
  assert.match(human, /FAIL\s+CK-02\.3/);
  assert.match(
    human,
    /MUST: Implementations MUST be safe under concurrent subjects/,
  );
  assert.match(human, /detail: cross-subject store leak/);
  assert.match(human, /exit 1/);
  assert.equal(
    human.split("\n").some((l) => l.startsWith("PASS") && l.includes("MUST")),
    false,
  );
});

test("json report is parseable and stable for CI", () => {
  const report = buildRunReport([
    {
      obligationId: "CK-02.1",
      contract: "MemoryInterface",
      mustText: "`remember` MUST be durable before resolving.",
      outcome: "pass",
      attribution: "implementation",
      durationMs: 1,
      subjectId: "s",
    },
  ]);
  const parsed = JSON.parse(formatJsonReport(report));
  assert.equal(parsed.kind, "conformance-run-report");
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.verdicts[0].obligationId, "CK-02.1");
});

test("CLI --help exits 0", async () => {
  const io = memoryCapture();
  const code = await runConformanceCli(["--help"], io);
  assert.equal(code, 0);
  assert.match(io.stdout.text(), /--self-check/);
});

test("CLI self-check requires --subject-id (sovereignty)", async () => {
  const io = memoryCapture();
  const code = await runConformanceCli(["--self-check"], io);
  assert.equal(code, 1);
  assert.match(io.stderr.text(), /subject-id/);
});

test("CLI self-check known-good exits 0 with human table", async () => {
  const io = memoryCapture();
  const code = await runConformanceCli(
    ["--self-check", "--subject-id", "subj-cli", "--device-id", "dev-cli"],
    io,
  );
  assert.equal(code, 0);
  assert.match(io.stdout.text(), /PASS\s+CK-02\.1/);
  assert.match(io.stdout.text(), /PASS\s+CK-02\.3/);
  assert.match(io.stdout.text(), /exit 0/);
});

test("CLI --json emits machine-readable report", async () => {
  const io = memoryCapture();
  const code = await runConformanceCli(
    ["--self-check", "--json", "--subject-id", "subj-json"],
    io,
  );
  assert.equal(code, 0);
  const parsed = JSON.parse(io.stdout.text());
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.passed, 2);
});

test("CLI --emit-events writes structured events to stderr", async () => {
  const io = memoryCapture();
  const code = await runConformanceCli(
    [
      "--self-check",
      "--subject-id",
      "subj-events",
      "--emit-events",
      "--only",
      "CK-02.1",
    ],
    io,
  );
  assert.equal(code, 0);
  assert.match(io.stderr.text(), /"event":"conformance\.runner"/);
  assert.match(io.stderr.text(), /"subjectId":"subj-events::CK-02\.1"/);
});

test("CLI parse rejects unknown args", () => {
  const parsed = parseConformanceArgv(["--nope"]);
  assert.ok(parsed.errors.some((e) => /unknown/.test(e)));
});

test("edge: seeded violation via reporter shows MUST and exit 1", async () => {
  const MUST = "`remember` MUST be durable before resolving.";
  const registry = new ObligationRegistry();
  registry.register(
    defineObligation({
      id: "CK-02.1",
      contract: "MemoryInterface",
      mustText: MUST,
      specIds: ["CK-02"],
      async check() {
        throw new ObligationViolation({
          obligationId: "CK-02.1",
          mustText: MUST,
          contract: "MemoryInterface",
          message: "seeded",
        });
      },
    }),
  );
  const report = await runConformance({
    registry,
    factory: () => ({}),
    subjectId: "subj-fail",
  });
  const human = formatHumanReport(report);
  assert.equal(report.exitCode, 1);
  assert.match(human, /FAIL\s+CK-02\.1/);
  assert.match(human, /MUST: `remember` MUST be durable/);
});

test("edge: bin self-check process exit code is 0", () => {
  const result = spawnSync(
    process.execPath,
    [BIN, "--self-check", "--subject-id", "subj-bin", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.exitCode, 0);
});

test("edge: hanging selection times out and human report shows MUST", async () => {
  const MUST = "A hanging implementation MUST fail at the obligation deadline.";
  const registry = new ObligationRegistry();
  registry.register(
    defineObligation({
      id: "CK-99.hang",
      contract: "HarnessProbe",
      mustText: MUST,
      specIds: ["CK-01"],
      async check() {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 60_000);
          if (typeof timer.unref === "function") timer.unref();
        });
      },
    }),
  );
  const report = await runConformance({
    registry,
    factory: () => ({}),
    subjectId: "subj-hang",
    deadlineMs: 30,
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts[0].outcome, "timeout");
  const human = formatHumanReport(report);
  assert.match(human, /TIMEOUT\s+CK-99\.hang/);
  assert.match(human, /MUST: A hanging implementation MUST fail/);
});

test("external CLI: known-good factory passes selected published obligations", async () => {
  await withExternalFactory(
    `import { createDurableMemoryHarnessFactory } from ${JSON.stringify(DIST_URL)};
const createHarness = createDurableMemoryHarnessFactory();
export default function factory() {
  return createHarness();
}
`,
    async (factoryPath) => {
      const io = memoryCapture();
      const code = await runConformanceCli(
        [
          "--factory",
          factoryPath,
          "--subject-id",
          "subj-external",
          "--device-id",
          "dev-external",
          "--only",
          "CK-02.1,CK-02.3",
          "--json",
          "--emit-events",
        ],
        io,
      );

      assert.equal(code, 0, io.stderr.text());
      const report = JSON.parse(io.stdout.text());
      assert.equal(report.passed, 2);
      assert.equal(report.exitCode, 0);
      assert.deepEqual(
        report.verdicts.map((v) => v.obligationId),
        ["CK-02.1", "CK-02.3"],
      );
      assert.ok(report.verdicts.every((v) => /\bMUST\b/.test(v.mustText)));
      assert.match(io.stderr.text(), /"event":"conformance\.factory"/);
      assert.match(io.stderr.text(), /"subjectId":"subj-external"/);
      assert.match(io.stderr.text(), /"deviceId":"dev-external"/);

      const processResult = spawnSync(
        process.execPath,
        [
          BIN,
          "--factory",
          factoryPath,
          "--subject-id",
          "subj-external-bin",
          "--only",
          "CK-02.1",
          "--json",
        ],
        { encoding: "utf8" },
      );
      assert.equal(processResult.status, 0, processResult.stderr);
      assert.equal(JSON.parse(processResult.stdout).verdicts[0].obligationId, "CK-02.1");
    },
  );
});

test("external CLI: hanging factory times out one obligation without hanging runner", async () => {
  await withExternalFactory(
    `export default async function factory() {
  return new Promise(() => {});
}
`,
    async (factoryPath) => {
      const io = memoryCapture();
      const started = Date.now();
      const code = await runConformanceCli(
        [
          "--factory",
          factoryPath,
          "--subject-id",
          "subj-external-hang",
          "--only",
          "SYNC-01.1",
          "--deadline-ms",
          "30",
          "--json",
        ],
        io,
      );
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 2_000, `external CLI hung (${elapsed}ms)`);
      assert.equal(code, 1);
      const report = JSON.parse(io.stdout.text());
      assert.equal(report.timedOut, 1);
      assert.equal(report.verdicts[0].obligationId, "SYNC-01.1");
      assert.equal(report.verdicts[0].outcome, "timeout");
      assert.equal(report.verdicts[0].attribution, "implementation");
      assert.match(report.verdicts[0].mustText, /\bMUST\b/);
    },
  );
});

test("external CLI: async setup and teardown errors are implementation-attributed and redacted", async () => {
  await withExternalFactory(
    `export default async function factory() {
  throw new Error("raw learner secret from setup");
}
`,
    async (factoryPath) => {
      const io = memoryCapture();
      const code = await runConformanceCli(
        [
          "--factory",
          factoryPath,
          "--subject-id",
          "subj-setup-error",
          "--only",
          "SYNC-01.1",
          "--json",
        ],
        io,
      );
      assert.equal(code, 1);
      const report = JSON.parse(io.stdout.text());
      assert.equal(report.verdicts[0].attribution, "implementation");
      assert.equal(
        report.verdicts[0].message,
        "implementation factory setup failed",
      );
      assert.doesNotMatch(io.stdout.text(), /raw learner secret/);
    },
  );

  await withExternalFactory(
    `import { createDurableMemoryHarnessFactory } from ${JSON.stringify(DIST_URL)};
const createHarness = createDurableMemoryHarnessFactory();
export default function factory() {
  return createHarness();
}
export async function teardown() {
  throw new Error("raw learner secret from teardown");
}
`,
    async (factoryPath) => {
      const io = memoryCapture();
      const code = await runConformanceCli(
        [
          "--factory",
          factoryPath,
          "--subject-id",
          "subj-teardown-error",
          "--only",
          "CK-02.1",
          "--json",
        ],
        io,
      );
      assert.equal(code, 1);
      const report = JSON.parse(io.stdout.text());
      assert.equal(report.verdicts[0].attribution, "implementation");
      assert.equal(
        report.verdicts[0].message,
        "implementation teardown failed",
      );
      assert.doesNotMatch(io.stdout.text(), /raw learner secret/);
    },
  );
});

test("external CLI: cross-subject factory fails exactly the isolation obligation", async () => {
  await withExternalFactory(
    `import { validSyncRequestProducer } from ${JSON.stringify(DIST_URL)};
export default function factory() {
  const valid = validSyncRequestProducer();
  return {
    produceSyncRequest(ctx) {
      const request = valid.produceSyncRequest(ctx);
      request.edgeState.subjectId = "other-subject";
      return request;
    }
  };
}
`,
    async (factoryPath) => {
      const io = memoryCapture();
      const code = await runConformanceCli(
        [
          "--factory",
          factoryPath,
          "--subject-id",
          "subj-isolation",
          "--only",
          "SYNC-01.2",
          "--json",
        ],
        io,
      );
      assert.equal(code, 1);
      const report = JSON.parse(io.stdout.text());
      assert.equal(report.failed, 1);
      assert.equal(report.verdicts.length, 1);
      assert.equal(report.verdicts[0].obligationId, "SYNC-01.2");
      assert.equal(report.verdicts[0].outcome, "fail");
      assert.match(report.verdicts[0].mustText, /subjectId.*MUST/i);
    },
  );
});

test("external CLI: missing factory export is a typed metadata-only load failure", async () => {
  await withExternalFactory(
    `export const notAFactory = "raw learner secret";\n`,
    async (factoryPath) => {
      const io = memoryCapture();
      const code = await runConformanceCli(
        [
          "--factory",
          factoryPath,
          "--subject-id",
          "subj-load-error",
          "--device-id",
          "dev-load-error",
          "--emit-events",
        ],
        io,
      );
      assert.equal(code, 1);
      assert.match(io.stderr.text(), /factory_export_missing/);
      assert.match(io.stderr.text(), /"event":"conformance\.factory"/);
      assert.match(io.stderr.text(), /"subjectId":"subj-load-error"/);
      assert.match(io.stderr.text(), /"deviceId":"dev-load-error"/);
      assert.doesNotMatch(io.stderr.text(), /raw learner secret/);
    },
  );
});
