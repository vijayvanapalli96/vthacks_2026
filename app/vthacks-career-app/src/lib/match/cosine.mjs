/**
 * cosine.mjs — cosine similarity, twice: once as SQL and once as JavaScript.
 *
 * The SQL is what actually runs. Plain SQL cosine over `ARRAY<FLOAT>` is a
 * SETTLED decision (docs/MATCH_AGENT_PLAN.md, decisions table): no Vector Search
 * index, because at 16k rows a full scan is workable and an index is a new
 * moving part. `vthacks-vs` staying at 0 indexes is a later demo upgrade, not a
 * dependency of this agent.
 *
 * The JavaScript exists because the SQL cannot be unit-tested without a
 * warehouse, and the arithmetic is the kind that fails silently — a sum of
 * products that forgets to normalise still returns plausible-looking numbers in
 * the right order, so a bug survives eyeballing the output. `cosine()` pins the
 * two facts that catch it: identical vectors are exactly 1, orthogonal vectors
 * are exactly 0.
 *
 * They are kept adjacent, in one file, on purpose. Two copies of a formula in
 * two files drift; two copies four lines apart do not.
 */

/**
 * Cosine similarity of two equal-length numeric vectors.
 *
 * Returns 0 for a zero vector rather than NaN. A zero-magnitude embedding is not
 * "maximally dissimilar", it is *undefined* — but NaN propagates into an ORDER BY
 * and sorts unpredictably, so it would corrupt a ranking rather than being
 * visible in it. 0 is the value that keeps such a row at the bottom where a
 * caller can see it.
 *
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number} -1..1
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    throw new TypeError(
      `cosine() needs two non-empty vectors of equal length; got ${a?.length} and ${b?.length}`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  // CLAMPED, and this is not cosmetic. cosine(v, v) evaluates to
  // 1.0000000000000002 in IEEE 754 for most real vectors, because the dot product
  // and the two norms accumulate rounding differently. A `similarity` column
  // holding 1.0000000000000002 is a value a reader has to stop and think about,
  // and any downstream code that asserts 0..1 breaks on it. The clamp costs
  // nothing and makes the two identities the unit test pins — identical -> 1,
  // orthogonal -> 0 — exactly true rather than approximately true.
  return Math.min(1, Math.max(-1, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}

/**
 * The same formula as a SQL expression over two `ARRAY<FLOAT>` columns.
 *
 * `CAST(... AS DOUBLE)` on every element is not decoration. The columns are
 * ARRAY<FLOAT>, and summing 1024 single-precision products in single precision
 * loses enough of the tail to reorder near-ties — which is precisely the region
 * where the top-20 cut is made. `zip_with` + `AGGREGATE` is used rather than
 * EXPLODE + GROUP BY because it stays inside one row and avoids a 16,206 * 1024
 * row intermediate.
 *
 * NULLIF on the denominator mirrors the zero-vector guard above: a zero-magnitude
 * embedding yields NULL rather than a divide-by-zero, and `COALESCE(..., 0)`
 * lands it at the bottom of the ORDER BY instead of an unpredictable position.
 *
 * @param {string} left  - SQL expression for the first ARRAY<FLOAT>
 * @param {string} right - SQL expression for the second ARRAY<FLOAT>
 * @returns {string} a SQL scalar expression in -1..1
 */
export function cosineSql(left, right) {
  const norm = (v) =>
    `SQRT(AGGREGATE(TRANSFORM(${v}, x -> CAST(x AS DOUBLE) * CAST(x AS DOUBLE)), 0D, (acc, x) -> acc + x))`;
  const dot = `AGGREGATE(zip_with(${left}, ${right}, (x, y) -> CAST(x AS DOUBLE) * CAST(y AS DOUBLE)), 0D, (acc, x) -> acc + x)`;
  // GREATEST/LEAST mirror the JS clamp above for the same reason: identical
  // vectors would otherwise store as 1.0000000000000002.
  return `GREATEST(-1D, LEAST(1D, COALESCE(${dot} / NULLIF(${norm(left)} * ${norm(right)}, 0), 0)))`;
}
