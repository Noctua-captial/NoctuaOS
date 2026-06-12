// Breeden-Litzenberger risk-neutral density — the market's own probability
// distribution for the underlier at expiry, recovered from one expiry's
// option chain (Breeden-Litzenberger 1978: q(K) = e^{rT} ∂²C/∂K²).
// Pipeline: OTM IV points → least-squares quadratic smile in log-moneyness →
// dense Black-Scholes call curve → second difference in strike → clip
// negatives, normalize. Pure functions; null on thin or junk chains rather
// than fabricated precision.

export type ChainContract = {
  type: "C" | "P";
  strike: number;
  mid: number | null; // mid quote in $; ≤ 0 or null marks a dead quote
  iv: number | null; // annualized implied vol, decimal (CBOE provides per contract)
};

export type ChainSlice = {
  spot: number;
  expiryYears: number;
  riskFreeRate?: number; // annualized, default 0.04
  contracts: ChainContract[];
};

export type RiskNeutralDensity = {
  strikes: number[]; // ascending uniform grid
  density: number[]; // q(K) ≥ 0, trapezoid-normalized to unit mass
};

const DEFAULT_RATE = 0.04;
const MIN_USABLE_STRIKES = 6;
const GRID_POINTS = 801;
const STRIKE_BAND = 0.6; // drop strikes beyond ±60% of spot — mostly junk prints on small caps
const VOL_FLOOR = 0.05;
const VOL_CEIL = 3;
const MIN_EXPIRY_YEARS = 1 / 365;
const WING_SIGMAS = 6; // grid half-width in ATM stdevs (log space)
const MAX_LOG_HALF_WIDTH = 2.5; // cap grid at ~e^±2.5 of forward even for extreme vols
const MIN_LOG_HALF_WIDTH = 0.35; // always cover ±35% in log space for tail metrics

/** Standard normal CDF — Abramowitz & Stegun 26.2.17, |error| < 7.5e-8. */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Discounted Black-Scholes call on the forward: df·(F·N(d1) − K·N(d2)). */
function bsCall(forward: number, strike: number, vol: number, years: number, df: number): number {
  if (vol <= 0 || years <= 0) return df * Math.max(forward - strike, 0);
  const sT = vol * Math.sqrt(years);
  const d1 = Math.log(forward / strike) / sT + sT / 2;
  return df * (forward * normCdf(d1) - strike * normCdf(d1 - sT));
}

/** Solve a 3×3 linear system by Gaussian elimination with partial pivoting. */
function solve3(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = col + 1; r < 3; r++) {
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = m[r][3];
    for (let c = r + 1; c < 3; c++) s -= m[r][c] * x[c];
    x[r] = s / m[r][r];
  }
  return x.every(Number.isFinite) ? x : null;
}

/**
 * Least-squares quadratic smile iv(k) = a + b·k + c·k² in log-moneyness
 * k = ln(K/F). Quadratic, not SVI: on sparse small-cap chains SVI's five
 * coupled parameters routinely degenerate or need delicate seeding, while a
 * three-parameter parabola is a closed-form fit that cannot diverge —
 * robustness over elegance.
 */
function fitSmile(points: { k: number; iv: number }[]): { a: number; b: number; c: number } | null {
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (const p of points) {
    const k = p.k, k2 = k * k;
    s1 += k; s2 += k2; s3 += k2 * k; s4 += k2 * k2;
    t0 += p.iv; t1 += k * p.iv; t2 += k2 * p.iv;
  }
  const n = points.length;
  const sol = solve3(
    [
      [n, s1, s2],
      [s1, s2, s3],
      [s2, s3, s4],
    ],
    [t0, t1, t2],
  );
  return sol ? { a: sol[0], b: sol[1], c: sol[2] } : null;
}

function trapezoidMass(xs: number[], ys: number[]): number {
  let acc = 0;
  for (let i = 1; i < xs.length; i++) acc += ((ys[i - 1] + ys[i]) / 2) * (xs[i] - xs[i - 1]);
  return acc;
}

/**
 * Risk-neutral density for one expiry. Builds the smile from OTM contracts
 * only (calls above spot, puts below — the liquid side), filters junk quotes
 * (iv ≤ 0 or > 5, mid ≤ 0, strikes beyond ±60% of spot), requires ≥ 6 usable
 * strikes, then prices a dense call curve from the fitted smile and second-
 * differences it. Null when the chain cannot support an honest density.
 */
export function riskNeutralDensity(slice: ChainSlice): RiskNeutralDensity | null {
  const { spot, expiryYears } = slice;
  const rate = slice.riskFreeRate ?? DEFAULT_RATE;
  if (!Number.isFinite(spot) || spot <= 0) return null;
  if (!Number.isFinite(expiryYears) || expiryYears < MIN_EXPIRY_YEARS) return null;
  if (!Number.isFinite(rate)) return null;

  const forward = spot * Math.exp(rate * expiryYears);

  const seen = new Set<number>();
  const points: { k: number; iv: number }[] = [];
  for (const c of slice.contracts) {
    if (!Number.isFinite(c.strike) || c.strike <= 0) continue;
    if (c.iv == null || !Number.isFinite(c.iv) || c.iv <= 0 || c.iv > 5) continue;
    if (c.mid == null || !Number.isFinite(c.mid) || c.mid <= 0) continue;
    const otm = c.type === "C" ? c.strike >= spot : c.strike < spot;
    if (!otm) continue;
    if (Math.abs(c.strike / spot - 1) > STRIKE_BAND) continue;
    if (seen.has(c.strike)) continue;
    seen.add(c.strike);
    points.push({ k: Math.log(c.strike / forward), iv: c.iv });
  }
  if (points.length < MIN_USABLE_STRIKES) return null;

  const smile = fitSmile(points);
  if (!smile) return null;

  // Evaluate the parabola everywhere; clamp only the vol VALUE. Clamping
  // log-moneyness instead would kink the smile where vega is still large and
  // spike the density; the value clamp binds only in far wings where vega ≈ 0.
  const volAt = (k: number): number => {
    const v = smile.a + smile.b * k + smile.c * k * k;
    return Math.min(Math.max(v, VOL_FLOOR), VOL_CEIL);
  };

  const atmVol = volAt(0);
  const halfWidth = Math.min(
    Math.max(WING_SIGMAS * atmVol * Math.sqrt(expiryYears), MIN_LOG_HALF_WIDTH),
    MAX_LOG_HALF_WIDTH,
  );
  const kMin = Math.min(forward * Math.exp(-halfWidth), spot * 0.7);
  const kMax = Math.max(forward * Math.exp(halfWidth), spot * 1.3);

  // Call curve on GRID_POINTS+2 strikes; density via second differences on
  // the interior GRID_POINTS. BL 1978: q(K) = e^{rT}·(C(K−h) − 2C(K) + C(K+h))/h².
  const n = GRID_POINTS + 2;
  const h = (kMax - kMin) / (n - 1);
  if (!(h > 0)) return null;
  const df = Math.exp(-rate * expiryYears);
  const calls: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const strike = kMin + i * h;
    calls[i] = bsCall(forward, strike, volAt(Math.log(strike / forward)), expiryYears, df);
  }

  const grow = Math.exp(rate * expiryYears);
  const strikes: number[] = new Array(GRID_POINTS);
  const density: number[] = new Array(GRID_POINTS);
  for (let i = 1; i < n - 1; i++) {
    const q = (grow * (calls[i - 1] - 2 * calls[i] + calls[i + 1])) / (h * h);
    strikes[i - 1] = kMin + i * h;
    density[i - 1] = Number.isFinite(q) && q > 0 ? q : 0; // clip negatives (finite-difference noise)
  }

  // Honesty guard: raw mass far from 1 means the fit or grid is broken —
  // normalizing garbage would manufacture a confident-looking distribution.
  const mass = trapezoidMass(strikes, density);
  if (!Number.isFinite(mass) || mass < 0.6 || mass > 1.4) return null;
  for (let i = 0; i < density.length; i++) density[i] /= mass;

  return { strikes, density };
}

/** P(price at expiry > `price`) by trapezoid integration of the density. */
export function probAbove(rnd: RiskNeutralDensity, price: number): number {
  const { strikes, density } = rnd;
  const n = strikes.length;
  if (n < 2 || !Number.isFinite(price)) return 0;
  if (price <= strikes[0]) return 1;
  if (price >= strikes[n - 1]) return 0;
  let acc = 0;
  for (let i = n - 2; i >= 0; i--) {
    const a = strikes[i];
    const b = strikes[i + 1];
    if (b <= price) break;
    if (a >= price) {
      acc += ((density[i] + density[i + 1]) / 2) * (b - a);
    } else {
      const t = (price - a) / (b - a);
      const dAt = density[i] + t * (density[i + 1] - density[i]);
      acc += ((dAt + density[i + 1]) / 2) * (b - price);
      break;
    }
  }
  return Math.min(Math.max(acc, 0), 1);
}

/** P(price at expiry < `price`) — complement, so above + below ≡ 1. */
export function probBelow(rnd: RiskNeutralDensity, price: number): number {
  return Math.min(Math.max(1 - probAbove(rnd, price), 0), 1);
}

function moments(rnd: RiskNeutralDensity): { mean: number; stdev: number } | null {
  const { strikes, density } = rnd;
  if (strikes.length < 2) return null;
  let m1 = 0;
  let m2 = 0;
  for (let i = 1; i < strikes.length; i++) {
    const dx = strikes[i] - strikes[i - 1];
    m1 += ((strikes[i - 1] * density[i - 1] + strikes[i] * density[i]) / 2) * dx;
    m2 +=
      ((strikes[i - 1] ** 2 * density[i - 1] + strikes[i] ** 2 * density[i]) / 2) * dx;
  }
  const variance = Math.max(m2 - m1 * m1, 0);
  if (!Number.isFinite(m1) || !Number.isFinite(variance)) return null;
  return { mean: m1, stdev: Math.sqrt(variance) };
}

/**
 * Implied move as a fraction: stdev of the RND over its mean. The RND mean is
 * the forward, which differs from spot only by e^{rT} (< 1% on short
 * horizons), so this is the implied move on spot without needing spot passed.
 */
export function impliedMovePct(rnd: RiskNeutralDensity): number | null {
  const m = moments(rnd);
  if (!m || m.mean <= 0) return null;
  return m.stdev / m.mean;
}

/**
 * Tail asymmetry: P(+20%) / P(−20%), reference = `spot` when given, else the
 * RND mean. > 1 means the market prices the up-tail fatter than the down-tail.
 * Null when the down-tail carries no measurable mass (a ratio would be noise).
 */
export function tailAsymmetry(rnd: RiskNeutralDensity, spot?: number): number | null {
  const ref = spot ?? moments(rnd)?.mean;
  if (ref == null || !Number.isFinite(ref) || ref <= 0) return null;
  const up = probAbove(rnd, ref * 1.2);
  const down = probBelow(rnd, ref * 0.8);
  if (down < 1e-9) return null;
  return up / down;
}
