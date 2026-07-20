/**
 * Incremental AICA-style token / tool-call parser.
 *
 * Pure chunk scanner with explicit modes (thought / answer / tool_buffer /
 * violation). Emits typed parse events; never executes tool payloads.
 * Grammar matches A P6 golden input: `<thought>…</thought>`,
 * fenced ```` ```tool_call` ```` bodies, and free prose as answer.
 *
 * A P6 golden-turn fixture bytes are imported under
 * {@link A_P6_GOLDEN_TURNS_FIXTURE_RELPATH} and loaded via `golden_turn_loader`
 * for replay tests / CI (expectedFrames stay the committed A P6 bytes).
 */

import { A_P6_GOLDEN_TURNS_FIXTURE_RELPATH } from "./golden_turn_loader.js";

export { A_P6_GOLDEN_TURNS_FIXTURE_RELPATH };

/** Declared parser modes (epic / design). */
export const PARSER_MODES = [
  "thought",
  "answer",
  "tool_buffer",
  "violation",
] as const;

export type ParserMode = (typeof PARSER_MODES)[number];

/** Soft NFR bounds — hot-path carry / tool buffer ceilings. */
export const PARSER_CARRY_MAX = 8_192;
export const PARSER_TOOL_BUFFER_MAX = 16_384;

export type ParserFailureClass =
  | "missing_subject"
  | "carry_budget_exceeded"
  | "tool_buffer_budget_exceeded"
  | "malformed_fence"
  | "nested_fence"
  | "undeclared_markup"
  | "unclosed_fence"
  | "unclosed_at_deadline"
  | "cross_subject";

/**
 * Explicit mode transition table — control-flow contract for the scanner.
 * `violation → answer` is recovery after a typed violation (discard complete).
 */
export const PARSER_MODE_TRANSITIONS = [
  { from: "answer", on: "open_thought", to: "thought" },
  { from: "answer", on: "open_tool_fence", to: "tool_buffer" },
  { from: "answer", on: "malformed_markup", to: "violation" },
  { from: "thought", on: "close_thought", to: "answer" },
  { from: "thought", on: "nested_or_malformed", to: "violation" },
  { from: "tool_buffer", on: "close_tool_fence", to: "answer" },
  { from: "tool_buffer", on: "nested_or_malformed", to: "violation" },
  { from: "tool_buffer", on: "deadline", to: "violation" },
  { from: "thought", on: "deadline", to: "violation" },
  /** Incomplete declared-tag prefix still held in answer carry. */
  { from: "answer", on: "deadline_held_fragment", to: "violation" },
  { from: "violation", on: "recover", to: "answer" },
] as const;

export type ParserModeTransition = (typeof PARSER_MODE_TRANSITIONS)[number];

export type ParseEvent =
  | { type: "mode_change"; from: ParserMode; to: ParserMode; reason: string }
  | { type: "thought_delta"; delta: string }
  | { type: "answer_delta"; delta: string }
  | { type: "tool_buffer_delta"; delta: string }
  | { type: "tool_buffer"; body: string }
  | {
      type: "violation";
      failureClass: ParserFailureClass;
      detail: string;
      discardedBytes: number;
    };

/** Metadata-only telemetry — never thought/answer/tool payload text. */
export type ToolCallParserTelemetryEvent = {
  event: "runtime.harness.parser";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  mode?: ParserMode;
  failureClass?: ParserFailureClass;
  chunkBytes?: number;
  eventCount?: number;
  /** Bytes held as an incomplete tag fragment (never payload text). */
  heldFragmentBytes?: number;
};

export type ToolCallParserOptions = {
  subjectId: string;
  deviceId?: string;
  onTelemetry?: (event: ToolCallParserTelemetryEvent) => void;
};

/**
 * Declared grammar tags. Fuzz tests split streams at every character offset
 * of these markers to prove chunk-boundary reassembly.
 */
export const PARSER_DECLARED_TAGS = Object.freeze({
  openThought: "<thought>",
  closeThought: "</thought>",
  openToolFence: "```tool_call\n",
  closeToolFence: "\n```",
} as const);

export type ParserDeclaredTagName = keyof typeof PARSER_DECLARED_TAGS;

const OPEN_THOUGHT = PARSER_DECLARED_TAGS.openThought;
const CLOSE_THOUGHT = PARSER_DECLARED_TAGS.closeThought;
const OPEN_TOOL_FENCE = PARSER_DECLARED_TAGS.openToolFence;
const OPEN_TOOL_PREFIX = "```tool_call";
const CLOSE_TOOL = PARSER_DECLARED_TAGS.closeToolFence;

/**
 * True when `suffix` is a proper prefix of a declared tag (must stay in the
 * carry buffer until the tag completes or a deadline discards it).
 * Tool-fence matching is case-insensitive on the `tool_call` segment.
 */
export function isTagFragmentPrefix(suffix: string): boolean {
  if (suffix.length === 0) return false;

  for (const marker of Object.values(PARSER_DECLARED_TAGS)) {
    if (marker.startsWith(suffix)) return true;
  }

  // Case-insensitive open-tool fragment: ```tool_call[\n]?
  const lower = suffix.toLowerCase();
  if (
    OPEN_TOOL_PREFIX.startsWith(lower) ||
    OPEN_TOOL_FENCE.startsWith(lower)
  ) {
    return true;
  }

  // Ambiguous one-char starts that begin every backtick / angle tag.
  if (suffix === "`" || suffix === "<") return true;

  // Close-tool incomplete without the leading newline yet handled above via
  // closeToolFence prefixes; also hold `\n`` / `\n` when they can still grow
  // into `\n``` ` but not a bare `\n` (would break answer purity).
  if (suffix === "\n`" || suffix === "\n``") return true;

  // Incomplete angle markup that is not a declared-tag prefix must still be
  // held until `>` — otherwise `<fo` + `o>` chunks leak undeclared tags into
  // answer. Completed markup is classified by stepAnswer (violation vs thought).
  if (suffix.startsWith("<") && !suffix.includes(">")) return true;

  return false;
}

/**
 * Index of the longest trailing tag fragment that must be held.
 * Returns `buf.length` when the whole buffer is safe to emit/accumulate.
 */
export function tagFragmentHoldStart(buf: string): number {
  for (let i = buf.length; i >= 1; i--) {
    const suffix = buf.slice(buf.length - i);
    if (isTagFragmentPrefix(suffix)) return buf.length - i;
  }
  return buf.length;
}

function findOpenThought(buf: string): number {
  return buf.indexOf(OPEN_THOUGHT);
}

function findCloseThought(buf: string): number {
  return buf.indexOf(CLOSE_THOUGHT);
}

/** Case-insensitive ```tool_call\n opener; returns index of leading backticks. */
function findOpenTool(buf: string): number {
  const lower = buf.toLowerCase();
  let from = 0;
  while (from < lower.length) {
    const i = lower.indexOf(OPEN_TOOL_PREFIX, from);
    if (i < 0) return -1;
    const after = i + OPEN_TOOL_PREFIX.length;
    if (after < buf.length && buf[after] === "\n") return i;
    // Incomplete at end — held via tagFragmentHoldStart.
    if (after >= buf.length) return -1;
    from = i + 1;
  }
  return -1;
}

/**
 * Close fence is `\n```` that is not the start of another ````tool_call`
 * opener. When `allowEof` is false, a trailing `\n```` with no following
 * bytes is held (more chunks may still reveal a nested open).
 */
function findCloseTool(
  buf: string,
  opts: { allowEof: boolean } = { allowEof: false },
): number {
  let from = 0;
  while (from < buf.length) {
    const i = buf.indexOf(CLOSE_TOOL, from);
    if (i < 0) return -1;
    const after = buf.slice(i + CLOSE_TOOL.length);
    if (/^tool_call\b/i.test(after)) {
      from = i + 1;
      continue;
    }
    if (after.length === 0) {
      return opts.allowEof ? i : -1;
    }
    // Incomplete `tool_call` after the ticks — keep holding.
    const lower = after.toLowerCase();
    if (
      "tool_call".startsWith(lower) &&
      lower.length < "tool_call".length
    ) {
      return -1;
    }
    return i;
  }
  return -1;
}

/**
 * Subject-scoped incremental parser. Pure/replayable: same concatenated
 * byte stream → same event sequence regardless of chunk boundaries.
 */
export class ToolCallParser {
  readonly subjectId: string;
  readonly deviceId: string | undefined;

  private mode: ParserMode = "answer";
  private carry = "";
  private toolBuffer = "";
  /** Accumulators so chunk splits do not change the logical event sequence. */
  private answerAcc = "";
  private thoughtAcc = "";
  /**
   * After undeclared `<…>` markup, drop further stream bytes for this parse
   * (matches single-chunk discard of tag remainder). Keeps chunk splits from
   * leaking inner prose as answer_delta.
   */
  private suppressAnswer = false;
  private readonly onTelemetry:
    | ((event: ToolCallParserTelemetryEvent) => void)
    | undefined;

  constructor(opts: ToolCallParserOptions) {
    const subjectId =
      typeof opts.subjectId === "string" ? opts.subjectId.trim() : "";
    if (!subjectId) {
      throw new Error("ToolCallParser requires non-empty subjectId");
    }
    this.subjectId = subjectId;
    this.deviceId = opts.deviceId;
    this.onTelemetry = opts.onTelemetry;
  }

  get currentMode(): ParserMode {
    return this.mode;
  }

  /**
   * Discard open tool/thought buffers and return to answer mode so the
   * correction loop can re-engage generation without duplicate tool buffers.
   */
  resetToSafeMode(): void {
    this.mode = "answer";
    this.carry = "";
    this.toolBuffer = "";
    this.answerAcc = "";
    this.thoughtAcc = "";
    this.suppressAnswer = false;
  }

  /**
   * Emit accumulated answer/thought text without treating the stream as EOF
   * (open tool fences are not terminated). Used after correction re-feed.
   */
  flushPendingDeltas(): ParseEvent[] {
    if (this.mode === "thought") {
      return this.flushThought();
    }
    if (this.mode === "answer") {
      return this.flushAnswer();
    }
    return [];
  }

  /** Bytes held awaiting more input (partial tags / open fences). */
  get pendingBytes(): number {
    return (
      this.carry.length +
      this.toolBuffer.length +
      this.answerAcc.length +
      this.thoughtAcc.length
    );
  }

  /**
   * Feed the next stream chunk. Empty chunks are a no-op (no mode churn).
   * Does not execute tools — tool bodies are emitted for downstream validation.
   */
  feed(chunk: string): ParseEvent[] {
    if (typeof chunk !== "string") {
      return this.violate("malformed_fence", "chunk must be a string", 0);
    }
    if (chunk.length === 0) {
      this.telemetryOk(0, 0, this.heldFragmentBytes);
      return [];
    }

    this.carry += chunk;
    if (this.carry.length > PARSER_CARRY_MAX) {
      const discarded = this.carry.length + this.toolBuffer.length;
      this.carry = "";
      this.toolBuffer = "";
      return this.violate(
        "carry_budget_exceeded",
        `carry exceeded ${PARSER_CARRY_MAX}`,
        discarded,
      );
    }

    const events = this.drain();
    this.telemetryOk(chunk.length, events.length, this.heldFragmentBytes);
    return events;
  }

  /** Bytes of carry that are an incomplete declared-tag prefix. */
  get heldFragmentBytes(): number {
    if (this.carry.length === 0) return 0;
    const start = tagFragmentHoldStart(this.carry);
    return start < this.carry.length ? this.carry.length - start : 0;
  }

  /**
   * End of stream: open fences become unclosed_fence violations (buffer discard).
   * Remaining safe answer/thought text is flushed.
   */
  end(): ParseEvent[] {
    const events: ParseEvent[] = [];
    if (this.mode === "tool_buffer") {
      // EOF may complete a held `\n``` ` close that was waiting for more input.
      events.push(...this.stepToolBuffer({ allowEof: true }));
      if (this.mode === "tool_buffer") {
        events.push(
          ...this.violate(
            "unclosed_fence",
            "unclosed tool_buffer at end of stream",
            this.toolBuffer.length + this.carry.length,
          ),
        );
      } else {
        events.push(...this.flushAnswer());
      }
      this.telemetryOk(0, events.length, this.heldFragmentBytes);
      return events;
    }
    if (this.mode === "thought") {
      events.push(
        ...this.violate(
          "unclosed_fence",
          "unclosed thought at end of stream",
          this.carry.length + this.thoughtAcc.length,
        ),
      );
      return events;
    }
    if (this.carry.length > 0 && this.mode === "answer") {
      // Trailing hold that never completed a tag → violation; else answer.
      if (isTagFragmentPrefix(this.carry) && this.carry.includes("<")) {
        events.push(
          ...this.violate(
            "unclosed_fence",
            "incomplete markup at end of stream",
            this.carry.length,
          ),
        );
      } else if (isTagFragmentPrefix(this.carry) && this.carry.startsWith("`")) {
        events.push(
          ...this.violate(
            "unclosed_fence",
            "incomplete tool fence at end of stream",
            this.carry.length,
          ),
        );
      } else {
        this.answerAcc += this.carry;
        this.carry = "";
      }
    }
    events.push(...this.flushAnswer());
    this.telemetryOk(0, events.length, this.heldFragmentBytes);
    return events;
  }

  /**
   * True when a fence or incomplete tag fragment would block waiting for more
   * bytes — hosts must call {@link terminateDeadline} rather than hang.
   */
  get hasOpenFence(): boolean {
    return (
      this.mode === "tool_buffer" ||
      this.mode === "thought" ||
      (this.mode === "answer" && this.heldFragmentBytes > 0)
    );
  }

  /**
   * Deadline with an open fence / held tag fragment → violation + discard.
   * Synchronous and idempotent: never waits for a close tag. Discarded tool /
   * thought bytes are never forwarded as answer_delta.
   */
  terminateDeadline(): ParseEvent[] {
    if (!this.hasOpenFence) {
      this.telemetryOk(0, 0, this.heldFragmentBytes);
      return [];
    }

    if (this.mode === "tool_buffer") {
      const discarded =
        this.toolBuffer.length + this.carry.length + this.thoughtAcc.length;
      // Drop any deferred answer flush of fence debris: body never becomes answer.
      this.answerAcc = "";
      return this.violate(
        "unclosed_at_deadline",
        "deadline with open tool_buffer; buffer discarded",
        discarded,
      );
    }

    if (this.mode === "thought") {
      const discarded = this.thoughtAcc.length + this.carry.length;
      return this.violate(
        "unclosed_at_deadline",
        "deadline with open thought; buffer discarded",
        discarded,
      );
    }

    // Answer mode holding an incomplete declared-tag prefix (e.g. ```tool_).
    const discarded = this.carry.length;
    // Do not emit the held fragment as answer_delta.
    this.carry = "";
    return this.violate(
      "unclosed_at_deadline",
      "deadline with incomplete tag fragment; hold discarded",
      discarded,
    );
  }

  private drain(): ParseEvent[] {
    const events: ParseEvent[] = [];
    let guard = 0;
    while (guard++ < PARSER_CARRY_MAX) {
      const before = this.carry.length + this.toolBuffer.length + this.mode;
      const step = this.step();
      events.push(...step);
      const after = this.carry.length + this.toolBuffer.length + this.mode;
      if (step.length === 0 && after === before) break;
      if (this.carry.length === 0 && this.mode === "answer" && step.length === 0)
        break;
    }
    return events;
  }

  private step(): ParseEvent[] {
    switch (this.mode) {
      case "answer":
        return this.stepAnswer();
      case "thought":
        return this.stepThought();
      case "tool_buffer":
        return this.stepToolBuffer({ allowEof: false });
      case "violation":
        // Sticky content while recovering is discarded without answer forward.
        if (this.carry.length > 0) {
          const n = this.carry.length;
          this.carry = "";
          return [
            {
              type: "violation",
              failureClass: "undeclared_markup",
              detail: "content discarded in violation mode",
              discardedBytes: n,
            },
          ];
        }
        return this.recoverToAnswer();
      default:
        return [];
    }
  }

  private stepAnswer(): ParseEvent[] {
    if (this.suppressAnswer) {
      this.carry = "";
      this.answerAcc = "";
      return [];
    }

    const buf = this.carry;
    if (buf.length === 0) return [];

    const thoughtAt = findOpenThought(buf);
    const toolAt = findOpenTool(buf);

    let next = -1;
    let kind: "thought" | "tool" | null = null;
    if (thoughtAt >= 0 && (toolAt < 0 || thoughtAt < toolAt)) {
      next = thoughtAt;
      kind = "thought";
    } else if (toolAt >= 0) {
      next = toolAt;
      kind = "tool";
    }

    if (kind === "thought" && next >= 0) {
      const events: ParseEvent[] = [];
      if (next > 0) this.answerAcc += buf.slice(0, next);
      events.push(...this.flushAnswer());
      this.carry = buf.slice(next + OPEN_THOUGHT.length);
      events.push(...this.enter("thought", "open_thought"));
      return events;
    }

    if (kind === "tool" && next >= 0) {
      const events: ParseEvent[] = [];
      if (next > 0) this.answerAcc += buf.slice(0, next);
      events.push(...this.flushAnswer());
      // Consume ```tool_call\n
      this.carry = buf.slice(next + OPEN_TOOL_PREFIX.length + 1);
      this.toolBuffer = "";
      events.push(...this.enter("tool_buffer", "open_tool_fence"));
      return events;
    }

    // Complete but unknown markup starting with `<…>` → violation.
    const lt = buf.indexOf("<");
    if (lt >= 0) {
      const gt = buf.indexOf(">", lt);
      if (gt >= 0) {
        const tag = buf.slice(lt, gt + 1);
        if (tag !== OPEN_THOUGHT && tag !== CLOSE_THOUGHT) {
          const events: ParseEvent[] = [];
          if (lt > 0) this.answerAcc += buf.slice(0, lt);
          events.push(...this.flushAnswer());
          this.carry = buf.slice(gt + 1);
          events.push(
            ...this.violate(
              "undeclared_markup",
              "markup outside declared grammar",
              tag.length,
            ),
          );
          return events;
        }
      }
    }

    // Hold incomplete marker suffix; accumulate safe prefix as answer.
    const holdAt = tagFragmentHoldStart(buf);
    if (holdAt < buf.length) {
      if (holdAt > 0) {
        this.answerAcc += buf.slice(0, holdAt);
        this.carry = buf.slice(holdAt);
      }
      // Keep answerAcc until a mode boundary so chunking stays pure.
      return [];
    }

    this.answerAcc += buf;
    this.carry = "";
    return [];
  }

  private stepThought(): ParseEvent[] {
    const buf = this.carry;
    if (buf.length === 0) return [];

    // Nested open thought or tool fence inside thought → violation.
    const nestedThought = findOpenThought(buf);
    const nestedTool = findOpenTool(buf);
    const closeAt = findCloseThought(buf);

    if (nestedThought >= 0 && (closeAt < 0 || nestedThought < closeAt)) {
      this.carry = buf.slice(nestedThought);
      this.thoughtAcc = "";
      return this.violate(
        "nested_fence",
        "nested <thought> while already in thought mode",
        this.toolBuffer.length,
      );
    }
    if (nestedTool >= 0 && (closeAt < 0 || nestedTool < closeAt)) {
      this.carry = buf.slice(nestedTool);
      this.thoughtAcc = "";
      return this.violate(
        "nested_fence",
        "tool fence nested inside thought",
        0,
      );
    }

    if (closeAt >= 0) {
      const events: ParseEvent[] = [];
      this.thoughtAcc += buf.slice(0, closeAt);
      events.push(...this.flushThought());
      this.carry = buf.slice(closeAt + CLOSE_THOUGHT.length);
      events.push(...this.enter("answer", "close_thought"));
      return events;
    }

    const holdAt = tagFragmentHoldStart(buf);
    if (holdAt < buf.length) {
      if (holdAt > 0) {
        this.thoughtAcc += buf.slice(0, holdAt);
        this.carry = buf.slice(holdAt);
      }
      return [];
    }

    this.thoughtAcc += buf;
    this.carry = "";
    return [];
  }

  private stepToolBuffer(
    opts: { allowEof: boolean } = { allowEof: false },
  ): ParseEvent[] {
    // toolBuffer holds body so far; carry holds unfinished stream bytes.
    if (this.carry.length === 0) return [];

    const closeAt = findCloseTool(this.carry, opts);
    const nestedInCarry = findOpenTool(this.carry);
    if (nestedInCarry >= 0 && (closeAt < 0 || nestedInCarry < closeAt)) {
      // Discard only the abandoned outer fence body — not the nested opener
      // (kept in carry) or later stream. Keeps discardedBytes chunk-invariant.
      const discarded = this.toolBuffer.length + nestedInCarry;
      this.toolBuffer = "";
      this.carry = this.carry.slice(nestedInCarry);
      return this.violate(
        "nested_fence",
        "nested tool_call fence; buffer discarded",
        discarded,
      );
    }

    if (closeAt >= 0) {
      const events: ParseEvent[] = [];
      const piece = this.carry.slice(0, closeAt);
      if (piece.length > 0) {
        if (this.toolBuffer.length + piece.length > PARSER_TOOL_BUFFER_MAX) {
          const discarded = this.toolBuffer.length + this.carry.length;
          this.toolBuffer = "";
          this.carry = "";
          return this.violate(
            "tool_buffer_budget_exceeded",
            `tool buffer exceeded ${PARSER_TOOL_BUFFER_MAX}`,
            discarded,
          );
        }
        this.toolBuffer += piece;
      }
      const body = this.toolBuffer;
      this.toolBuffer = "";
      this.carry = this.carry.slice(closeAt + CLOSE_TOOL.length);
      // Single delta + complete — chunk-invariant.
      if (body.length > 0) {
        events.push({ type: "tool_buffer_delta", delta: body });
      }
      events.push({ type: "tool_buffer", body });
      events.push(...this.enter("answer", "close_tool_fence"));
      return events;
    }

    // Hold possible incomplete close `\n``` ` suffix.
    const holdAt = tagFragmentHoldStart(this.carry);
    if (holdAt < this.carry.length) {
      if (holdAt > 0) {
        const piece = this.carry.slice(0, holdAt);
        if (this.toolBuffer.length + piece.length > PARSER_TOOL_BUFFER_MAX) {
          const discarded = this.toolBuffer.length + this.carry.length;
          this.toolBuffer = "";
          this.carry = "";
          return this.violate(
            "tool_buffer_budget_exceeded",
            `tool buffer exceeded ${PARSER_TOOL_BUFFER_MAX}`,
            discarded,
          );
        }
        this.toolBuffer += piece;
        this.carry = this.carry.slice(holdAt);
      }
      return [];
    }

    const piece = this.carry;
    if (this.toolBuffer.length + piece.length > PARSER_TOOL_BUFFER_MAX) {
      const discarded = this.toolBuffer.length + this.carry.length;
      this.toolBuffer = "";
      this.carry = "";
      return this.violate(
        "tool_buffer_budget_exceeded",
        `tool buffer exceeded ${PARSER_TOOL_BUFFER_MAX}`,
        discarded,
      );
    }
    this.toolBuffer += piece;
    this.carry = "";
    return [];
  }

  private flushAnswer(): ParseEvent[] {
    if (this.answerAcc.length === 0) return [];
    const delta = this.answerAcc;
    this.answerAcc = "";
    return [{ type: "answer_delta", delta }];
  }

  private flushThought(): ParseEvent[] {
    if (this.thoughtAcc.length === 0) return [];
    const delta = this.thoughtAcc;
    this.thoughtAcc = "";
    return [{ type: "thought_delta", delta }];
  }

  private enter(to: ParserMode, reason: string): ParseEvent[] {
    const from = this.mode;
    if (from === to) return [];
    this.mode = to;
    return [{ type: "mode_change", from, to, reason }];
  }

  private recoverToAnswer(): ParseEvent[] {
    if (this.mode !== "violation") return [];
    return this.enter("answer", "recover");
  }

  private violate(
    failureClass: ParserFailureClass,
    detail: string,
    discardedBytes: number,
  ): ParseEvent[] {
    const events: ParseEvent[] = [];
    events.push(...this.flushAnswer());
    this.thoughtAcc = "";
    if (this.mode !== "violation") {
      events.push(...this.enter("violation", failureClass));
    }
    this.toolBuffer = "";
    // Leave carry when nested markup remains so drain can continue.
    if (failureClass !== "nested_fence") {
      this.carry = "";
    }
    if (failureClass === "undeclared_markup") {
      // Remainder after the tag (and later chunks) must not become answer —
      // same as wiping carry on single-chunk undeclared detection.
      this.suppressAnswer = true;
      this.answerAcc = "";
    }
    events.push({
      type: "violation",
      failureClass,
      detail,
      discardedBytes,
    });
    events.push(...this.recoverToAnswer());
    this.telemetryRejected(failureClass);
    return events;
  }

  private telemetryOk(
    chunkBytes: number,
    eventCount: number,
    heldFragmentBytes: number,
  ): void {
    if (!this.onTelemetry) return;
    this.onTelemetry({
      event: "runtime.harness.parser",
      outcome: "ok",
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      mode: this.mode,
      chunkBytes,
      eventCount,
      heldFragmentBytes,
    });
  }

  private telemetryRejected(failureClass: ParserFailureClass): void {
    if (!this.onTelemetry) return;
    this.onTelemetry({
      event: "runtime.harness.parser",
      outcome: "rejected",
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      mode: this.mode,
      failureClass,
    });
  }
}

/**
 * Feed all chunks then end(); convenience for golden-style replay tests.
 * Pure: identical to sequential feed of the concatenated stream when chunking
 * respects tag holds (same events for any split of the same bytes).
 */
export function parseChunks(
  chunks: readonly string[],
  opts: ToolCallParserOptions,
): ParseEvent[] {
  const parser = new ToolCallParser(opts);
  const events: ParseEvent[] = [];
  for (const chunk of chunks) {
    events.push(...parser.feed(chunk));
  }
  events.push(...parser.end());
  return events;
}
