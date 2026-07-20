/**
 * Line-oriented unified diff for golden replay CI drift output.
 * No third-party dependency — keeps the gate portable and pinned.
 */

export type UnifiedDiffOptions = {
  fromFile?: string;
  toFile?: string;
  context?: number;
};

/**
 * Return a unified diff string, or "" when expected === actual (LF-normalized).
 */
export function unifiedDiff(
  expected: string,
  actual: string,
  opts: UnifiedDiffOptions = {},
): string {
  const fromFile = opts.fromFile ?? "expected";
  const toFile = opts.toFile ?? "actual";
  const context = Number.isInteger(opts.context) ? (opts.context as number) : 3;

  const a = String(expected).replace(/\r\n/g, "\n").split("\n");
  const b = String(actual).replace(/\r\n/g, "\n").split("\n");
  if (a.length > 0 && a[a.length - 1] === "") a.pop();
  if (b.length > 0 && b[b.length - 1] === "") b.pop();

  if (a.length === b.length && a.every((line, i) => line === b[i])) {
    return "";
  }

  const ops = diffOps(a, b);
  const hunks = buildHunks(ops, context);
  const parts = [`--- ${fromFile}\n`, `+++ ${toFile}\n`];
  for (const hunk of hunks) {
    parts.push(
      `@@ -${hunk.aStart},${hunk.aCount} +${hunk.bStart},${hunk.bCount} @@\n`,
    );
    for (const line of hunk.lines) {
      parts.push(`${line}\n`);
    }
  }
  return parts.join("");
}

type DiffOp =
  | { type: "equal"; line: string }
  | { type: "delete"; line: string }
  | { type: "insert"; line: string };

function diffOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "delete", line: a[i]! });
      i++;
    } else {
      ops.push({ type: "insert", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "delete", line: a[i++]! });
  while (j < m) ops.push({ type: "insert", line: b[j++]! });
  return ops;
}

type Hunk = {
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
  lines: string[];
};

function buildHunks(ops: DiffOp[], context: number): Hunk[] {
  const changeIdx: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.type !== "equal") changeIdx.push(i);
  }
  if (changeIdx.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  let start = Math.max(0, changeIdx[0]! - context);
  let end = Math.min(ops.length, changeIdx[0]! + context + 1);
  for (let k = 1; k < changeIdx.length; k++) {
    const c = changeIdx[k]!;
    const nextStart = Math.max(0, c - context);
    const nextEnd = Math.min(ops.length, c + context + 1);
    if (nextStart <= end) {
      end = nextEnd;
    } else {
      ranges.push({ start, end });
      start = nextStart;
      end = nextEnd;
    }
  }
  ranges.push({ start, end });

  const hunks: Hunk[] = [];
  for (const range of ranges) {
    let aStart = 1;
    let bStart = 1;
    for (let i = 0; i < range.start; i++) {
      if (ops[i]!.type !== "insert") aStart++;
      if (ops[i]!.type !== "delete") bStart++;
    }
    let aCount = 0;
    let bCount = 0;
    const lines: string[] = [];
    for (let i = range.start; i < range.end; i++) {
      const op = ops[i]!;
      if (op.type === "equal") {
        lines.push(` ${op.line}`);
        aCount++;
        bCount++;
      } else if (op.type === "delete") {
        lines.push(`-${op.line}`);
        aCount++;
      } else {
        lines.push(`+${op.line}`);
        bCount++;
      }
    }
    hunks.push({ aStart, aCount, bStart, bCount, lines });
  }
  return hunks;
}
