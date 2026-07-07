// Minimal benchmark harness: warmup, timed iterations, p50/p95/p99 report.

export async function bench(name, fn, { warmup = 20, iterations = 200 } = {}) {
  for (let i = 0; i < warmup; i++) await fn(i);

  const samples = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn(i);
    samples[i] = performance.now() - t0;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;

  console.log(
    `${name.padEnd(38)} p50=${pct(50).toFixed(3)}ms  p95=${pct(95).toFixed(3)}ms  p99=${pct(99).toFixed(3)}ms  mean=${mean.toFixed(3)}ms  ops/s=${(1000 / mean).toFixed(0)}`,
  );
  return { p50: pct(50), p95: pct(95), p99: pct(99), mean };
}
