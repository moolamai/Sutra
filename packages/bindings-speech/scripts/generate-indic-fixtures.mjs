#!/usr/bin/env node
/**
 * Generate committed Indic / code-switched PCM fixtures under fixtures/indic/.
 * Run from package root: node scripts/generate-indic-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../fixtures/indic");
const audioDir = path.join(root, "audio");
mkdirSync(audioDir, { recursive: true });

const SAMPLE_RATE = 16_000;

function pcmFor(text, durationMs) {
  const samples = Math.max(1, Math.floor((SAMPLE_RATE * durationMs) / 1000));
  const bytes = new Uint8Array(samples * 2);
  const enc = new TextEncoder().encode(text);
  bytes.set(enc.slice(0, Math.min(enc.length, bytes.length)));
  for (let i = Math.ceil(enc.length / 2); i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const v = Math.floor(Math.sin(2 * Math.PI * 220 * t) * 800);
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >> 8) & 0xff;
  }
  return bytes;
}

const fixtures = [
  {
    id: "hi-greeting",
    kind: "indic-mono",
    language: "hi-IN",
    durationMs: 600,
    text: "नमस्ते कक्षा",
    containsCodeSwitch: false,
  },
  {
    id: "en-classroom",
    kind: "english-mono",
    language: "en-IN",
    durationMs: 700,
    text: "Please open your books",
    containsCodeSwitch: false,
  },
  {
    id: "ta-greeting",
    kind: "indic-mono",
    language: "ta-IN",
    durationMs: 650,
    text: "வணக்கம் வகுப்பு",
    containsCodeSwitch: false,
  },
  {
    id: "hi-en-codeswitch",
    kind: "code-switched",
    language: "hi-IN",
    durationMs: 900,
    text: "नमस्ते class, open your books अब",
    containsCodeSwitch: true,
  },
  {
    id: "short-hi",
    kind: "short-utterance",
    language: "hi-IN",
    durationMs: 120,
    text: "हाँ",
    containsCodeSwitch: false,
  },
  {
    id: "hi-classroom-noise",
    kind: "indic-classroom-noise",
    language: "hi-IN",
    durationMs: 900,
    // Probe prefix includes ambient-noise marker for in-process STT confidence drop.
    text: "NOISE:classroom नमस्ते कक्षा open books",
    containsCodeSwitch: true,
    ambientNoise: true,
  },
];

const catalog = {
  schemaVersion: "bindings-speech.indic-utterances.v1",
  sampleRateHz: SAMPLE_RATE,
  pcmEncoding: "s16le-mono",
  description:
    "Committed Indic + English + code-switched Hindi/English STT audio fixtures (PCM s16le mono @ 16kHz). A short UTF-8 probe is embedded at the PCM head for the whisper.cpp-class in-process seam; production backends decode acoustics and ignore the prefix.",
  utterances: [],
};

for (const f of fixtures) {
  const pcmRelpath = `audio/${f.id}.pcm`;
  const pcm = pcmFor(f.text, f.durationMs);
  writeFileSync(path.join(root, pcmRelpath), pcm);
  catalog.utterances.push({
    id: f.id,
    kind: f.kind,
    language: f.language,
    durationMs: f.durationMs,
    sampleRateHz: SAMPLE_RATE,
    pcmRelpath,
    byteLength: pcm.byteLength,
    containsCodeSwitch: f.containsCodeSwitch,
    expectedLanguage: f.language,
    ...(f.ambientNoise ? { ambientNoise: true } : {}),
  });
}

writeFileSync(
  path.join(root, "catalog.json"),
  `${JSON.stringify(catalog, null, 2)}\n`,
  "utf8",
);

console.log(`wrote ${catalog.utterances.length} fixtures under ${root}`);
for (const u of catalog.utterances) {
  console.log(`  ${u.id}: ${u.byteLength} bytes, ${u.durationMs}ms`);
}
