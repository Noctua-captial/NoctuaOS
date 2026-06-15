// Deterministic test helpers shared by the Math Lab specs. Mirrors the synthetic
// generators used in scripts/smoke-mathlab.ts so the ported assertions stay
// reproducible (seeded RNG + Box-Muller, local Black-Scholes for RND chains).
import { mulberry32 } from "@/lib/mathlab/montecarlo";

export function gaussians(seed: number): () => number {
  const rand = mulberry32(seed);
  let spare: number | null = null;
  return () => {
    if (spare != null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    do {
      u = rand();
    } while (u <= 1e-12);
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export function bsCall(f: number, k: number, vol: number, yrs: number, df: number): number {
  const sT = vol * Math.sqrt(yrs);
  const d1 = Math.log(f / k) / sT + sT / 2;
  return df * (f * normCdf(d1) - k * normCdf(d1 - sT));
}

export function bsPut(f: number, k: number, vol: number, yrs: number, df: number): number {
  const sT = vol * Math.sqrt(yrs);
  const d1 = Math.log(f / k) / sT + sT / 2;
  return df * (k * normCdf(-(d1 - sT)) - f * normCdf(-d1));
}

export function trapezoid(xs: number[], ys: number[]): number {
  let acc = 0;
  for (let i = 1; i < xs.length; i++) acc += ((ys[i - 1] + ys[i]) / 2) * (xs[i] - xs[i - 1]);
  return acc;
}

/** Three correlated return series (a, b≈0.6·a, c independent), seeded. */
export function correlatedReturns(seed: number, n: number): number[][] {
  const normal = gaussians(seed);
  const a: number[] = [];
  const b: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < n; i++) {
    const common = normal();
    a.push(0.01 * common);
    b.push(0.01 * (0.6 * common + 0.8 * normal()));
    c.push(0.012 * normal());
  }
  return [a, b, c];
}
