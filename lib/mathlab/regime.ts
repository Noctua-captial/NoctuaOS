// 2-state Gaussian hidden Markov model on daily returns — Baum-Welch EM with
// per-step scaling (Rabiner 1989) so long series never underflow. State 1 is
// always the higher-vol state ("stressed"); state 0 is "calm". The smoothed
// P(stressed) at the latest observation is the regime read.

const MIN_OBS = 150;
const VAR_FLOOR = 1e-10; // daily-return variance floor — keeps EM from collapsing a state
const EMISSION_FLOOR = 1e-100;
const CONVERGENCE_TOL = 1e-6;
const MAX_STRESS_DURATION_DAYS = 1000; // cap 1/(1−t11) when t11 → 1

export type HmmFit = {
  means: [number, number]; // daily-return mean per state [calm, stressed]
  vols: [number, number]; // daily-return stdev per state [calm, stressed]
  transition: number[][]; // 2×2 row-stochastic, [from][to]
  pStressedNow: number; // smoothed P(state = stressed) at the latest observation
  viterbiPath: number[]; // most likely state sequence, 0 = calm, 1 = stressed
};

type HmmParams = {
  pi: [number, number];
  A: number[][];
  means: [number, number];
  vars: [number, number];
};

function gaussPdf(x: number, mu: number, variance: number): number {
  const z = ((x - mu) * (x - mu)) / variance;
  return Math.exp(-0.5 * z) / Math.sqrt(2 * Math.PI * variance);
}

type ForwardBackward = {
  gamma: number[][]; // T×2 smoothed state probabilities
  xiSum: number[][]; // 2×2 expected transition counts
  logLik: number;
};

/** Scaled forward-backward pass (Rabiner 1989, §V): ĉ-normalized α and β keep
 * every quantity in [0,1] while Σ ln(c_t) recovers the log-likelihood. */
function forwardBackward(obs: number[], p: HmmParams): ForwardBackward | null {
  const T = obs.length;
  const b: number[][] = new Array(T);
  for (let t = 0; t < T; t++) {
    b[t] = [
      Math.max(gaussPdf(obs[t], p.means[0], p.vars[0]), EMISSION_FLOOR),
      Math.max(gaussPdf(obs[t], p.means[1], p.vars[1]), EMISSION_FLOOR),
    ];
  }

  const alpha: number[][] = new Array(T);
  const scale: number[] = new Array(T);
  {
    const a0 = p.pi[0] * b[0][0];
    const a1 = p.pi[1] * b[0][1];
    const c = a0 + a1;
    if (!(c > 0) || !Number.isFinite(c)) return null;
    scale[0] = c;
    alpha[0] = [a0 / c, a1 / c];
  }
  for (let t = 1; t < T; t++) {
    const prev = alpha[t - 1];
    const a0 = (prev[0] * p.A[0][0] + prev[1] * p.A[1][0]) * b[t][0];
    const a1 = (prev[0] * p.A[0][1] + prev[1] * p.A[1][1]) * b[t][1];
    const c = a0 + a1;
    if (!(c > 0) || !Number.isFinite(c)) return null;
    scale[t] = c;
    alpha[t] = [a0 / c, a1 / c];
  }

  const beta: number[][] = new Array(T);
  beta[T - 1] = [1, 1];
  for (let t = T - 2; t >= 0; t--) {
    const nb = b[t + 1];
    const nbeta = beta[t + 1];
    const c = scale[t + 1];
    beta[t] = [
      (p.A[0][0] * nb[0] * nbeta[0] + p.A[0][1] * nb[1] * nbeta[1]) / c,
      (p.A[1][0] * nb[0] * nbeta[0] + p.A[1][1] * nb[1] * nbeta[1]) / c,
    ];
  }

  const gamma: number[][] = new Array(T);
  for (let t = 0; t < T; t++) {
    const g0 = alpha[t][0] * beta[t][0];
    const g1 = alpha[t][1] * beta[t][1];
    const s = g0 + g1;
    gamma[t] = s > 0 ? [g0 / s, g1 / s] : [0.5, 0.5];
  }

  const xiSum = [
    [0, 0],
    [0, 0],
  ];
  for (let t = 0; t < T - 1; t++) {
    const c = scale[t + 1];
    let tot = 0;
    const x = [
      [0, 0],
      [0, 0],
    ];
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const v = (alpha[t][i] * p.A[i][j] * b[t + 1][j] * beta[t + 1][j]) / c;
        x[i][j] = v;
        tot += v;
      }
    }
    if (tot > 0) {
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) xiSum[i][j] += x[i][j] / tot;
    }
  }

  let logLik = 0;
  for (let t = 0; t < T; t++) logLik += Math.log(scale[t]);
  if (!Number.isFinite(logLik)) return null;

  return { gamma, xiSum, logLik };
}

/** Viterbi decode in log space; returns the most likely 0/1 state path. */
function viterbi(obs: number[], p: HmmParams): number[] {
  const T = obs.length;
  const logA = [
    [Math.log(Math.max(p.A[0][0], 1e-12)), Math.log(Math.max(p.A[0][1], 1e-12))],
    [Math.log(Math.max(p.A[1][0], 1e-12)), Math.log(Math.max(p.A[1][1], 1e-12))],
  ];
  const logEmit = (t: number, j: number): number => {
    const v = p.vars[j];
    return -0.5 * (Math.log(2 * Math.PI * v) + ((obs[t] - p.means[j]) * (obs[t] - p.means[j])) / v);
  };
  const delta: number[][] = new Array(T);
  const psi: number[][] = new Array(T);
  delta[0] = [
    Math.log(Math.max(p.pi[0], 1e-12)) + logEmit(0, 0),
    Math.log(Math.max(p.pi[1], 1e-12)) + logEmit(0, 1),
  ];
  psi[0] = [0, 0];
  for (let t = 1; t < T; t++) {
    delta[t] = [0, 0];
    psi[t] = [0, 0];
    for (let j = 0; j < 2; j++) {
      const from0 = delta[t - 1][0] + logA[0][j];
      const from1 = delta[t - 1][1] + logA[1][j];
      psi[t][j] = from1 > from0 ? 1 : 0;
      delta[t][j] = Math.max(from0, from1) + logEmit(t, j);
    }
  }
  const path = new Array<number>(T);
  path[T - 1] = delta[T - 1][1] > delta[T - 1][0] ? 1 : 0;
  for (let t = T - 2; t >= 0; t--) path[t] = psi[t + 1][path[t + 1]];
  return path;
}

/**
 * Fit a 2-state Gaussian HMM by Baum-Welch EM. Requires ≥ 150 finite
 * observations; null on degenerate data (zero variance, dead state, NaN).
 * States are reordered post-fit so index 1 is the higher-vol one.
 */
export function fitHMM(returns: number[], maxIter = 50): HmmFit | null {
  const obs = returns.filter((x) => Number.isFinite(x));
  const T = obs.length;
  if (T < MIN_OBS) return null;
  const mean = obs.reduce((s, x) => s + x, 0) / T;
  const sd = Math.sqrt(obs.reduce((s, x) => s + (x - mean) ** 2, 0) / (T - 1));
  if (!(sd > 0)) return null;

  // Symmetry broken by seeding one low-vol and one high-vol state.
  const p: HmmParams = {
    pi: [0.8, 0.2],
    A: [
      [0.97, 0.03],
      [0.05, 0.95],
    ],
    means: [mean, mean],
    vars: [(0.6 * sd) ** 2, (1.6 * sd) ** 2],
  };

  let prevLL = -Infinity;
  for (let iter = 0; iter < maxIter; iter++) {
    const fb = forwardBackward(obs, p);
    if (!fb) return null;
    if (Math.abs(fb.logLik - prevLL) < CONVERGENCE_TOL * (1 + Math.abs(fb.logLik))) break;
    prevLL = fb.logLik;

    const { gamma, xiSum } = fb;
    const gSum = [0, 0];
    const gSumT1 = [0, 0]; // sums over t < T−1 (denominator for transitions)
    for (let t = 0; t < T; t++) {
      gSum[0] += gamma[t][0];
      gSum[1] += gamma[t][1];
      if (t < T - 1) {
        gSumT1[0] += gamma[t][0];
        gSumT1[1] += gamma[t][1];
      }
    }
    if (gSum[0] < 1e-8 || gSum[1] < 1e-8) return null; // a state died — fit is degenerate

    p.pi = [gamma[0][0], gamma[0][1]];
    for (let i = 0; i < 2; i++) {
      const denom = Math.max(gSumT1[i], 1e-12);
      let row0 = xiSum[i][0] / denom;
      let row1 = xiSum[i][1] / denom;
      const rs = row0 + row1;
      if (rs > 0) {
        row0 /= rs;
        row1 /= rs;
      } else {
        row0 = 0.5;
        row1 = 0.5;
      }
      p.A[i] = [row0, row1];
    }
    for (let j = 0; j < 2; j++) {
      let num = 0;
      for (let t = 0; t < T; t++) num += gamma[t][j] * obs[t];
      p.means[j] = num / gSum[j];
      let varNum = 0;
      for (let t = 0; t < T; t++) varNum += gamma[t][j] * (obs[t] - p.means[j]) ** 2;
      p.vars[j] = Math.max(varNum / gSum[j], VAR_FLOOR);
    }
  }

  // Final E-step with the converged parameters (gamma must match them).
  const final = forwardBackward(obs, p);
  if (!final) return null;

  // Order states by vol: index 1 = stressed.
  let order: [number, number] = [0, 1];
  if (p.vars[0] > p.vars[1]) order = [1, 0];
  const [c, s] = order;
  const ordered: HmmParams = {
    pi: [p.pi[c], p.pi[s]],
    A: [
      [p.A[c][c], p.A[c][s]],
      [p.A[s][c], p.A[s][s]],
    ],
    means: [p.means[c], p.means[s]],
    vars: [p.vars[c], p.vars[s]],
  };

  return {
    means: ordered.means,
    vols: [Math.sqrt(ordered.vars[0]), Math.sqrt(ordered.vars[1])],
    transition: ordered.A,
    pStressedNow: final.gamma[T - 1][s],
    viterbiPath: viterbi(obs, ordered),
  };
}

export type RegimeLabel = "calm" | "transitioning" | "stressed";

export type RegimeRead = {
  pStressed: number;
  expectedStressDurationDays: number; // 1/(1 − t11): mean sojourn in the stressed state
  label: RegimeLabel; // < 0.25 calm, > 0.6 stressed, else transitioning
};

/** One-call regime read from a return series; null when the HMM cannot fit. */
export function regimeRead(returns: number[]): RegimeRead | null {
  const fit = fitHMM(returns);
  if (!fit) return null;
  const t11 = fit.transition[1][1];
  const expectedStressDurationDays =
    t11 >= 1 - 1 / MAX_STRESS_DURATION_DAYS ? MAX_STRESS_DURATION_DAYS : 1 / (1 - t11);
  const label: RegimeLabel =
    fit.pStressedNow < 0.25 ? "calm" : fit.pStressedNow > 0.6 ? "stressed" : "transitioning";
  return { pStressed: fit.pStressedNow, expectedStressDurationDays, label };
}
