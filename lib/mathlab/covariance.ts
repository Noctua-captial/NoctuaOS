// Ledoit-Wolf (2004) shrinkage covariance — "Honey, I Shrunk the Sample
// Covariance Matrix". Sample covariances over short histories are mostly
// noise; shrinking toward the constant-correlation target (all pairs share
// the average correlation, variances kept) with the data-driven optimal
// intensity is provably closer to the truth in expectation. Plus the
// multivariate Kelly sizing and a historical CVaR governor built on it.

const MIN_OBS = 40; // matches MIN_OVERLAP discipline in lib/quant.ts

export type ShrunkCovariance = {
  cov: number[][];
  shrinkage: number; // δ* ∈ [0,1]: 0 = pure sample, 1 = pure target
};

/** Align per-asset return rows by their tails and drop any time point with a
 * non-finite entry. Returns demeaned asset-major series, or null when fewer
 * than MIN_OBS clean overlapping observations remain. */
function alignAndDemean(returnsMatrix: number[][]): number[][] | null {
  const p = returnsMatrix.length;
  if (p === 0) return null;
  let n = Infinity;
  for (const row of returnsMatrix) n = Math.min(n, row.length);
  if (!Number.isFinite(n) || n < MIN_OBS) return null;
  const tails = returnsMatrix.map((row) => row.slice(-n));

  const keep: number[] = [];
  for (let t = 0; t < n; t++) {
    let ok = true;
    for (let i = 0; i < p; i++) {
      if (!Number.isFinite(tails[i][t])) {
        ok = false;
        break;
      }
    }
    if (ok) keep.push(t);
  }
  if (keep.length < MIN_OBS) return null;

  const x: number[][] = [];
  for (let i = 0; i < p; i++) {
    const series = keep.map((t) => tails[i][t]);
    const m = series.reduce((s, v) => s + v, 0) / series.length;
    x.push(series.map((v) => v - m));
  }
  return x;
}

/**
 * Ledoit-Wolf 2004 estimator with the constant-correlation target:
 *   F_ii = S_ii,  F_ij = r̄·√(S_ii·S_jj)  (r̄ = mean sample correlation),
 *   δ* = clamp(((π̂ − ρ̂)/γ̂)/n, 0, 1),  Σ̂ = δ*·F + (1−δ*)·S.
 * Covariances use the 1/n convention (as in the paper). Null on fewer than
 * 40 clean overlapping observations or zero-variance assets.
 */
export function shrinkCovariance(returnsMatrix: number[][]): ShrunkCovariance | null {
  const x = alignAndDemean(returnsMatrix);
  if (!x) return null;
  const p = x.length;
  const n = x[0].length;

  const S: number[][] = [];
  for (let i = 0; i < p; i++) {
    S.push(new Array<number>(p).fill(0));
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let t = 0; t < n; t++) s += x[i][t] * x[j][t];
      S[i][j] = s / n;
    }
  }
  if (p === 1) {
    return S[0][0] > 0 ? { cov: [[S[0][0]]], shrinkage: 0 } : null;
  }

  const sd = S.map((row, i) => Math.sqrt(row[i]));
  if (sd.some((s) => !(s > 0))) return null;

  // r̄: average off-diagonal sample correlation.
  let rSum = 0;
  for (let i = 0; i < p; i++) {
    for (let j = i + 1; j < p; j++) rSum += S[i][j] / (sd[i] * sd[j]);
  }
  const rBar = (2 * rSum) / (p * (p - 1));

  // Target F.
  const F: number[][] = S.map((row, i) =>
    row.map((_, j) => (i === j ? S[i][i] : rBar * sd[i] * sd[j])),
  );

  // π̂: sum of asymptotic variances of the sample covariance entries.
  // θ̂_ii,ij terms feed ρ̂, the covariance between S and the target.
  let piHat = 0;
  let rhoHat = 0;
  let gammaHat = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      let pij = 0;
      let thetaII = 0;
      let thetaJJ = 0;
      for (let t = 0; t < n; t++) {
        const dij = x[i][t] * x[j][t] - S[i][j];
        pij += dij * dij;
        thetaII += (x[i][t] * x[i][t] - S[i][i]) * dij;
        thetaJJ += (x[j][t] * x[j][t] - S[j][j]) * dij;
      }
      pij /= n;
      thetaII /= n;
      thetaJJ /= n;
      piHat += pij;
      if (i === j) {
        rhoHat += pij; // diagonal of the target equals the sample diagonal
      } else {
        rhoHat += (rBar / 2) * ((sd[j] / sd[i]) * thetaII + (sd[i] / sd[j]) * thetaJJ);
      }
      gammaHat += (F[i][j] - S[i][j]) ** 2;
    }
  }

  let shrinkage = 0;
  if (gammaHat > 1e-20) {
    const kappa = (piHat - rhoHat) / gammaHat;
    shrinkage = Math.min(Math.max(kappa / n, 0), 1);
  }

  const cov = S.map((row, i) => row.map((s, j) => shrinkage * F[i][j] + (1 - shrinkage) * s));
  return { cov, shrinkage };
}

/** Solve A·x = b by Gaussian elimination with partial pivoting; null when
 * (near-)singular. Fine at portfolio sizes — n is single digits. */
function solveLinearSystem(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  if (a.length !== n || a.some((row) => row.length !== n)) return null;
  const m = a.map((row, i) => [...row, b[i]]);
  let maxAbs = 0;
  for (const row of m) for (const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
  if (!(maxAbs > 0)) return null;
  const tol = 1e-10 * maxAbs;

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < tol) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = col + 1; r < n; r++) {
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  const out = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let c = r + 1; c < n; c++) s -= m[r][c] * out[c];
    out[r] = s / m[r][r];
  }
  return out.every(Number.isFinite) ? out : null;
}

export type KellyInput = {
  expectedReturns: number[]; // μ — same horizon as cov (daily with daily, etc.)
  cov: number[][];
  capPerName: number; // max weight per name, fraction of NAV (e.g. 0.08)
  grossCap: number; // max Σ weights, fraction of NAV
};

/**
 * Growth-optimal weights w* = Σ⁻¹μ (Kelly 1956 / Merton portfolio choice),
 * then an approximate projection onto {0 ≤ w_i ≤ cap, Σw ≤ gross} by clipping
 * and rescaling — not a full QP, but at n ≤ 10 names the difference is noise
 * and the behavior is predictable. Long-only by design: negative Kelly
 * weights are clipped to zero (shorts are sized elsewhere). Note w* is
 * invariant to a common horizon rescaling of μ and Σ, so daily-consistent or
 * annual-consistent inputs give identical weights.
 */
export function multivariateKelly(input: KellyInput): number[] | null {
  const { expectedReturns, cov, capPerName, grossCap } = input;
  const n = expectedReturns.length;
  if (n === 0 || cov.length !== n) return null;
  if (!expectedReturns.every(Number.isFinite)) return null;
  if (!Number.isFinite(capPerName) || capPerName <= 0) return null;
  if (!Number.isFinite(grossCap) || grossCap <= 0) return null;

  const raw = solveLinearSystem(cov, expectedReturns);
  if (!raw) return null;

  let weights = raw.map((w) => Math.min(Math.max(w, 0), capPerName));
  const gross = weights.reduce((s, w) => s + w, 0);
  if (gross > grossCap && gross > 0) {
    weights = weights.map((w) => (w * grossCap) / gross);
  }
  return weights;
}

/**
 * Largest scale s ∈ [0,1] such that the historical CVaR-95 of the scaled
 * portfolio stays within `cvarLimitPct` (per-period loss as a positive
 * percent). CVaR is positively homogeneous — CVaR(s·w) = s·CVaR(w) — so the
 * answer is a simple ratio. Null when fewer than 40 clean observations.
 */
export function cvarConstrainedScale(
  weights: number[],
  returnsMatrix: number[][],
  cvarLimitPct: number,
): number | null {
  if (weights.length !== returnsMatrix.length || weights.length === 0) return null;
  if (!weights.every(Number.isFinite) || !Number.isFinite(cvarLimitPct)) return null;
  const x = alignAndDemean(returnsMatrix);
  if (!x) return null;
  const n = x[0].length;

  // Demeaning is fine here: CVaR of the centered distribution is the
  // conservative tail read (drift is not a risk control).
  const portfolio: number[] = new Array(n).fill(0);
  for (let i = 0; i < weights.length; i++) {
    for (let t = 0; t < n; t++) portfolio[t] += weights[i] * x[i][t];
  }
  portfolio.sort((a, b) => a - b);
  const tail = Math.max(1, Math.floor(0.05 * n));
  let tailSum = 0;
  for (let t = 0; t < tail; t++) tailSum += portfolio[t];
  const cvarLossPct = (-tailSum / tail) * 100;

  if (cvarLossPct <= 0) return 1; // no historical tail loss at this size
  if (!(cvarLimitPct > 0)) return 0;
  return Math.min(1, cvarLimitPct / cvarLossPct);
}
