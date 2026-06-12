// GARCH(1,1) on daily returns — σ²_t = ω + α·ε²_{t−1} + β·σ²_{t−1}
// (Bollerslev 1986), estimated by Gaussian maximum likelihood with variance
// targeting: ω is pinned to the sample variance via ω = σ²_LR·(1 − α − β),
// leaving a smooth 2-D likelihood in (α, β) that a coarse-to-fine grid search
// maximizes reliably — no gradients, no libraries, cannot diverge.

const TRADING_DAYS = 252;
const MIN_OBS = 250;
const STATIONARITY_CAP = 0.999; // enforce α + β < 0.999
const FORECAST_SESSIONS = 21; // 30 calendar days ≈ 21 trading sessions (matches CBOE iv30)
const GRID_REFINEMENTS = 3;

export type GarchFit = {
  omega: number;
  alpha: number;
  beta: number;
  longRunVolAnnualized: number; // √(σ²_LR · 252)
  forecastVol30dAnnualized: number; // √(mean forecast variance over 21 sessions · 252)
};

/** Gaussian log-likelihood of demeaned returns under GARCH(1,1) with variance targeting. */
function logLikelihood(e2: number[], varLR: number, alpha: number, beta: number): number {
  const omega = varLR * (1 - alpha - beta);
  const LOG_2PI = Math.log(2 * Math.PI);
  let v = varLR; // σ²_1 initialized at the long-run variance
  let ll = 0;
  for (const x2 of e2) {
    if (!(v > 0)) return -Infinity;
    ll -= 0.5 * (LOG_2PI + Math.log(v) + x2 / v);
    v = omega + alpha * x2 + beta * v;
  }
  return ll;
}

/**
 * Fit GARCH(1,1) by MLE (coarse-to-fine grid over α, β; ω from variance
 * targeting). Requires ≥ 250 finite observations; null otherwise or when the
 * likelihood is degenerate. Forecast vol is the 21-session-ahead average
 * variance from iterating E[σ²_{t+k+1}] = ω + (α+β)·E[σ²_{t+k}], annualized.
 */
export function fitGarch(returns: number[]): GarchFit | null {
  const r = returns.filter((x) => Number.isFinite(x));
  if (r.length < MIN_OBS) return null;
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  const e2 = r.map((x) => (x - m) ** 2);
  const varLR = e2.reduce((s, x) => s + x, 0) / e2.length;
  if (!(varLR > 0)) return null;

  let best = { alpha: 0, beta: 0, ll: -Infinity };
  let aLo = 0, aHi = 0.4, bLo = 0, bHi = 0.998, step = 0.02;
  for (let level = 0; level < GRID_REFINEMENTS; level++) {
    for (let a = aLo; a <= aHi + 1e-12; a += step) {
      for (let b = bLo; b <= bHi + 1e-12; b += step) {
        if (a + b >= STATIONARITY_CAP) continue;
        const ll = logLikelihood(e2, varLR, a, b);
        if (ll > best.ll) best = { alpha: a, beta: b, ll };
      }
    }
    aLo = Math.max(0, best.alpha - step);
    aHi = best.alpha + step;
    bLo = Math.max(0, best.beta - step);
    bHi = best.beta + step;
    step /= 5;
  }
  if (!Number.isFinite(best.ll)) return null;

  const { alpha, beta } = best;
  const omega = varLR * (1 - alpha - beta);

  // Filter the variance recursion through the sample to get σ²_{T+1} …
  let v = varLR;
  for (const x2 of e2) v = omega + alpha * x2 + beta * v;
  // … then iterate the forecast recursion 21 sessions out (E[ε²] = σ²).
  let acc = 0;
  let vk = v;
  for (let k = 0; k < FORECAST_SESSIONS; k++) {
    acc += vk;
    vk = omega + (alpha + beta) * vk;
  }
  const forecastVar = acc / FORECAST_SESSIONS;

  return {
    omega,
    alpha,
    beta,
    longRunVolAnnualized: Math.sqrt(varLR * TRADING_DAYS),
    forecastVol30dAnnualized: Math.sqrt(forecastVar * TRADING_DAYS),
  };
}

/**
 * Variance risk premium: (iv30 − forecast)/forecast. Positive = options
 * imply more vol than the model forecasts (fear rich); negative = implied
 * vol is cheap vs the forecast. Null on non-positive inputs.
 */
export function varianceRiskPremium(forecastVol: number, iv30: number): number | null {
  if (!Number.isFinite(forecastVol) || forecastVol <= 0) return null;
  if (!Number.isFinite(iv30) || iv30 <= 0) return null;
  return (iv30 - forecastVol) / forecastVol;
}
