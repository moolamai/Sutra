/**
 * Deterministic metadata-grade embeddings shared by memory + model mocks.
 *
 * @module embed
 */

/** Default reference embed width (matches CK-03 probes). */
export const REFERENCE_EMBED_DIM = 8;

/**
 * Stable character-histogram embedding, L2-normalized.
 * Dimension is fixed per call site (MUST for ModelInterface).
 */
export function embedText(
  text: string,
  dim: number = REFERENCE_EMBED_DIM,
): Float32Array {
  const v = new Float32Array(dim);
  const bounded = text.slice(0, 4096);
  for (let i = 0; i < bounded.length; i++) {
    v[bounded.charCodeAt(i) % dim]! += 1;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] = v[i]! / norm;
  return v;
}

/** Dot product of equal-length vectors. */
export function cosineLike(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}
