/**
 * Small deterministic PRNG + hashing helpers. Everything the mock generates is a pure function
 * of MOCK_SEED (and MOCK_TODAY for date anchoring), so these must never use Math.random().
 */

/** mulberry32: fast 32-bit PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer avalanche hash (lowbias32). */
export function hash32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Hash several integers into one 32-bit value. */
export function hashN(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) h = hash32(h ^ hash32(p | 0));
  return h;
}

/** Deterministic uniform in [0, 1) from integers. */
export function unitHash(...parts: number[]): number {
  return hashN(...parts) / 4294967296;
}

/** Hash a string to 32 bits (FNV-1a then avalanche). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return hash32(h);
}

export class Rng {
  private next: () => number;
  private spare: number | null = null;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Standard normal via Box-Muller (cached spare). */
  gauss(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
  /** Poisson sample; Knuth for small lambda, normal approximation above. */
  poisson(lambda: number): number {
    if (!(lambda > 0)) return 0;
    if (lambda < 20) {
      const l = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= this.next();
      } while (p > l);
      return k - 1;
    }
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.gauss()));
  }
  /** Pareto(xm=1, alpha) sample. */
  pareto(alpha: number): number {
    return Math.pow(1 - this.next(), -1 / alpha);
  }
}
