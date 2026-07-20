/**
 * offline-edge live demo — presentation layer for screen recordings and walkthroughs.
 *
 * Same proof as main-live.mjs (real Ollama, zero third-party egress) with a
 * narrative terminal UI. Use for demos; use main-live.mjs for automation.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runOfflineEdgeLiveTurn } from "sutra-bindings-slm";

const HERE = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(join(HERE, "golden-turn.json"), "utf8"),
);

const utterance =
  process.env.SUTRA_DEMO_UTTERANCE?.trim() ||
  process.argv.slice(2).join(" ").trim() ||
  golden.utterance;

const isTty = process.stdout.isTTY === true;

const esc = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  white: "\x1b[97m",
};

function paint(code, text) {
  return isTty ? `${code}${text}${esc.reset}` : text;
}

function hr(char = "─", width = 62) {
  console.log(paint(esc.dim, char.repeat(width)));
}

function banner() {
  console.log();
  console.log(
    paint(
      esc.bold + esc.cyan,
      "  ╔══════════════════════════════════════════════════════════╗",
    ),
  );
  console.log(
    paint(
      esc.bold + esc.cyan,
      "  ║  SUTRA · OFFLINE EDGE — sovereign on-device cognition    ║",
    ),
  );
  console.log(
    paint(
      esc.bold + esc.cyan,
      "  ╚══════════════════════════════════════════════════════════╝",
    ),
  );
  console.log(
    paint(
      esc.dim,
      "  Real EdgeAgent turn · local Ollama · zero cloud egress",
    ),
  );
  console.log();
}

function badge(ok, label) {
  const mark = ok ? paint(esc.green, "●") : paint(esc.red, "●");
  console.log(`  ${mark} ${label}`);
}

function wrap(text, width = 58, indent = "  ") {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

async function typewriter(text, delayMs = 12) {
  if (!isTty) {
    console.log(wrap(text));
    return;
  }
  process.stdout.write(paint(esc.white, "  "));
  for (const ch of text) {
    process.stdout.write(ch);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.log();
}

let phase = "init";

function setPhase(next) {
  phase = next;
}

function printPhase(label, detail) {
  const icons = {
    probe: "◎",
    load: "◈",
    think: "◐",
    locality: "◉",
    done: "✓",
  };
  const icon = icons[phase] ?? "·";
  console.log(
    paint(esc.dim, `  ${icon} `) +
      paint(esc.bold, label) +
      (detail ? paint(esc.dim, ` — ${detail}`) : ""),
  );
}

async function runDemo() {
  banner();

  console.log(paint(esc.bold, "  Learner"));
  console.log(
    paint(esc.dim, `  ${golden.profile.track} · ${golden.profile.language}`),
  );
  console.log();
  console.log(paint(esc.bold, "  Question"));
  console.log(wrap(utterance));
  console.log();
  hr();

  setPhase("probe");
  printPhase("Checking Ollama on loopback…");

  const started = Date.now();
  let modelTag = "…";

  const result = await runOfflineEdgeLiveTurn({
    utterance,
    onTelemetry: (event) => {
      if (event.outcome === "start") {
        modelTag = event.ollamaModel ?? modelTag;
        setPhase("load");
        printPhase("Model ready", `${modelTag} @ ${event.ollamaBaseUrl ?? "127.0.0.1:11434"}`);
        setPhase("think");
        printPhase("Cognitive turn in flight…", "EdgeAgent → CognitiveCore → Ollama");
      }
      if (event.outcome === "ollama_unreachable") {
        setPhase("done");
      }
    },
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log();
  hr();

  if (!result.ok) {
    console.log(paint(esc.bold + esc.red, "  Demo could not complete"));
    console.log();
    for (const failure of result.failures) {
      console.log(paint(esc.red, `  ✗ ${failure}`));
    }
    printHints(result);
    process.exitCode = 1;
    return;
  }

  setPhase("locality");
  console.log(paint(esc.bold + esc.green, "  On-device reply"));
  console.log();
  await typewriter(result.reply?.text?.trim() ?? "", 8);
  console.log();

  setPhase("done");
  console.log(paint(esc.bold, "  Sovereignty proof"));
  badge(result.servedLocally, "served locally — no cloud inference");
  badge(
    result.thirdPartyEgressCount === 0,
    `third-party egress: ${result.thirdPartyEgressCount} (cloud calls blocked)`,
  );
  badge(
    result.loopbackEgressCount > 0,
    `loopback only: ${result.loopbackEgressCount} call(s) to local Ollama`,
  );
  badge(
    result.syncStatus === "offline-mode",
    `sync: ${result.syncStatus} — no transport configured`,
  );
  badge(result.localityOk, "locality harness: passed");

  console.log();
  hr();
  console.log(
    paint(esc.dim, `  ${elapsed}s · model ${result.ollamaModel} · concept ${result.reply?.conceptId}`),
  );
  console.log(
    paint(esc.bold + esc.green, "\n  offline-edge demo OK — record this terminal for your README\n"),
  );
}

function printHints(result) {
  if (result.failures.some((f) => f.includes("not in /api/tags"))) {
    console.log();
    console.log(paint(esc.yellow, `  Hint: ollama pull ${result.ollamaModel}`));
  }
  const daemonMissing = result.failures.some(
    (f) =>
      /fetch failed|ECONNREFUSED|not reachable/i.test(f) ||
      f.includes("not in /api/tags"),
  );
  if (daemonMissing) {
    console.log();
    console.log(paint(esc.yellow, "  Install Ollama: winget install Ollama.Ollama"));
    console.log(paint(esc.yellow, "  Or: https://ollama.com/download"));
    console.log(paint(esc.yellow, `  Then: ollama pull ${result.ollamaModel}`));
  }
  console.log();
  console.log(
    paint(
      esc.dim,
      "  CI stand-in (no Ollama): pnpm --filter @moolam/examples offline-edge:llamacpp",
    ),
  );
}

await runDemo();
