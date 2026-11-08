/** Benjamini–Hochberg: returns which hypotheses are rejected at false-discovery rate q. */
export function benjaminiHochberg(pValues: number[], q: number): boolean[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let k = -1;
  order.forEach((o, rank) => {
    if (o.p <= ((rank + 1) / m) * q) k = rank;
  });
  const out = new Array<boolean>(m).fill(false);
  for (let r = 0; r <= k; r++) out[order[r]!.i] = true;
  return out;
}

/** BH-adjusted q-values (monotone). */
export function qValues(pValues: number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const q = new Array<number>(m).fill(1);
  let prev = 1;
  for (let r = m - 1; r >= 0; r--) {
    const v = Math.min(prev, (order[r]!.p * m) / (r + 1));
    q[order[r]!.i] = v;
    prev = v;
  }
  return q;
}

/**
 * Cost-sensitive threshold (Elkan 2001): alert when P(cause) ≥ C_FA / (C_FA + C_miss).
 * The user's sensitivity s ∈ (0,1) sets the cost ratio: higher sensitivity = misses cost more.
 */
export function causeThreshold(sensitivity: number): number {
  const cMiss = 1 + 9 * sensitivity; // 1..10
  const cFa = 1 + 9 * (1 - sensitivity);
  return cFa / (cFa + cMiss);
}
