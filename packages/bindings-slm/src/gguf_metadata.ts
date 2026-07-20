/**
 * Minimal GGUF header / metadata reader for truthful SlmModelCard fields.
 * Not a full tensor loader — native backends consume the weights path.
 */

export const GGUF_MAGIC = "GGUF";

/** Pinned llama.cpp revision this binding targets (document + CI pin). */
export const LLAMA_CPP_PINNED_REVISION = "b5750";

export type GgufMetadata = {
  /** Basename / general.name when present. */
  modelId: string;
  contextWindow: number;
  quantization: string;
  /** Rough peak RSS estimate from file size + quant overhead (MiB). */
  memoryFootprintMiB: number;
  languages: string[];
  architecture: string;
  fileBytes: number;
  ggufVersion: number;
};

const FILE_TYPE_QUANT: Record<number, string> = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
};

class GgufReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  seek(n: number): void {
    this.offset = n;
  }

  remaining(): number {
    return this.buf.length - this.offset;
  }

  u8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u32(): number {
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  f32(): number {
    const v = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    return v;
  }

  i32(): number {
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  string(): string {
    const len = Number(this.u64());
    if (len < 0 || len > this.remaining()) {
      throw new Error("gguf string length out of bounds");
    }
    const s = this.buf.subarray(this.offset, this.offset + len).toString("utf8");
    this.offset += len;
    return s;
  }

  skipValue(type: number): void {
    switch (type) {
      case 0: // UINT8
      case 1: // INT8
      case 8: // BOOL
        this.offset += 1;
        break;
      case 2: // UINT16
      case 3: // INT16
        this.offset += 2;
        break;
      case 4: // UINT32
      case 5: // INT32
      case 6: // FLOAT32
        this.offset += 4;
        break;
      case 7: // UINT64
      case 10: // INT64
      case 11: // FLOAT64
        this.offset += 8;
        break;
      case 9: // STRING
        this.string();
        break;
      case 12: {
        // ARRAY
        const elemType = this.u32();
        const n = Number(this.u64());
        for (let i = 0; i < n; i += 1) this.skipValue(elemType);
        break;
      }
      default:
        throw new Error(`unsupported gguf value type ${type}`);
    }
  }

  readValue(type: number): unknown {
    switch (type) {
      case 0:
        return this.u8();
      case 1:
        return this.buf.readInt8(this.offset++);
      case 4:
        return this.u32();
      case 5:
        return this.i32();
      case 6:
        return this.f32();
      case 8:
        return this.u8() !== 0;
      case 9:
        return this.string();
      case 12: {
        const elemType = this.u32();
        const n = Number(this.u64());
        const out: unknown[] = [];
        for (let i = 0; i < n; i += 1) out.push(this.readValue(elemType));
        return out;
      }
      default:
        this.skipValue(type);
        return undefined;
    }
  }
}

/**
 * Parse GGUF metadata enough to populate SlmModelCard.
 * Throws on missing/corrupt header — callers map to typed init errors.
 */
export function parseGgufMetadata(
  bytes: Uint8Array,
  opts: { weightsPath?: string } = {},
): GgufMetadata {
  if (bytes.byteLength < 24) {
    throw new Error("gguf file too short");
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = buf.subarray(0, 4).toString("ascii");
  if (magic !== GGUF_MAGIC) {
    throw new Error("gguf magic mismatch");
  }

  const reader = new GgufReader(buf);
  reader.seek(4);
  const version = reader.u32();
  if (version < 2 || version > 3) {
    throw new Error(`unsupported gguf version ${version}`);
  }
  // tensor_count
  reader.u64();
  const kvCount = Number(reader.u64());
  if (kvCount < 0 || kvCount > 10_000) {
    throw new Error("gguf metadata kv count out of bounds");
  }

  const kv: Record<string, unknown> = {};
  for (let i = 0; i < kvCount; i += 1) {
    const key = reader.string();
    const type = reader.u32();
    kv[key] = reader.readValue(type);
  }

  const arch =
    typeof kv["general.architecture"] === "string"
      ? (kv["general.architecture"] as string)
      : "llama";
  const name =
    typeof kv["general.name"] === "string"
      ? (kv["general.name"] as string)
      : opts.weightsPath
        ? basename(opts.weightsPath)
        : "unknown-gguf";

  const ctxKey = `${arch}.context_length`;
  const ctxRaw = kv[ctxKey] ?? kv["llama.context_length"] ?? kv["general.context_length"];
  const contextWindow =
    typeof ctxRaw === "number" && Number.isFinite(ctxRaw) && ctxRaw > 0
      ? Math.floor(ctxRaw)
      : 4096;

  const fileType = kv["general.file_type"];
  let quantization = "unknown";
  if (typeof fileType === "number" && FILE_TYPE_QUANT[fileType]) {
    quantization = FILE_TYPE_QUANT[fileType]!;
  } else if (typeof kv["general.quantization_version"] === "number") {
    quantization = `Q${kv["general.quantization_version"]}`;
  }

  const languages =
    Array.isArray(kv["general.languages"]) &&
    (kv["general.languages"] as unknown[]).every((x) => typeof x === "string")
      ? (kv["general.languages"] as string[])
      : ["en"];

  const fileBytes = bytes.byteLength;
  // Weight file size is a lower bound; add ~15% for runtime scratch.
  const memoryFootprintMiB = Math.max(
    1,
    Math.ceil((fileBytes / (1024 * 1024)) * 1.15),
  );

  return {
    modelId: name,
    contextWindow,
    quantization,
    memoryFootprintMiB,
    languages: languages.length > 0 ? languages : ["en"],
    architecture: arch,
    fileBytes,
    ggufVersion: version,
  };
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "model.gguf";
}

/**
 * Write a minimal GGUF fixture (no tensors) for unit tests.
 */
export function writeMinimalGguf(meta: {
  name: string;
  architecture?: string;
  contextLength: number;
  fileType?: number;
  languages?: string[];
}): Uint8Array {
  const architecture = meta.architecture ?? "llama";
  const chunks: Buffer[] = [];

  const pushU32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    chunks.push(b);
  };
  const pushU64 = (n: number | bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    chunks.push(b);
  };
  const pushString = (s: string) => {
    const raw = Buffer.from(s, "utf8");
    pushU64(raw.length);
    chunks.push(raw);
  };
  const pushKvString = (key: string, value: string) => {
    pushString(key);
    pushU32(9); // STRING
    pushString(value);
  };
  const pushKvU32 = (key: string, value: number) => {
    pushString(key);
    pushU32(4); // UINT32
    pushU32(value);
  };
  const pushKvStringArray = (key: string, values: string[]) => {
    pushString(key);
    pushU32(12); // ARRAY
    pushU32(9); // STRING elems
    pushU64(values.length);
    for (const v of values) pushString(v);
  };

  chunks.push(Buffer.from(GGUF_MAGIC, "ascii"));
  pushU32(3); // version
  pushU64(0); // tensor_count
  const kvs: Array<() => void> = [
    () => pushKvString("general.architecture", architecture),
    () => pushKvString("general.name", meta.name),
    () => pushKvU32(`${architecture}.context_length`, meta.contextLength),
    () => pushKvU32("general.file_type", meta.fileType ?? 15), // Q4_K_M
    () => pushKvStringArray("general.languages", meta.languages ?? ["en"]),
  ];
  pushU64(kvs.length);
  for (const write of kvs) write();

  return new Uint8Array(Buffer.concat(chunks));
}
