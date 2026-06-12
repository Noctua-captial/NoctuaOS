// Merton (1976) jump-diffusion Monte Carlo. Daily log-price step:
//   Δln S = (μ − λ·μ_J)·dt + σ·√dt·Z + Σ_{i ≤ N} J_i,
// N ~ Poisson(λ·dt), J ~ N(μ_J, σ_J²). The λ·μ_J·dt compensator keeps
// E[ln S_T] = ln S_0 + μ·T whatever the jump params: μ stays the single
// source of drift truth and jumps reshape the tails without smuggling in
// drift. Seeded PRNG (mulberry32) for reproducibility; Box-Muller normals.

const TRADING_DAYS = 252;

/** mulberry32 — tiny seeded 32-bit PRNG; identical seeds give identical streams. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller with a cached spare; consumes the supplied uniform stream. */
function gaussianSampler(rand: () => number): () => number {
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

/** Poisson via Knuth's product method — fast for the small λ·dt used here. */
function poissonSample(rand: () => number, lambda: number): number {
  if (!(lambda > 0)) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > limit);
  return k - 1;
}

export type JumpDiffusionParams = {
  spot: number;
  mu?: number; // annualized drift of LOG price (default 0 ⇒ median path flat)
  vol: number; // annualized diffusion vol, decimal
  jumpIntensity?: number; // expected jumps per year (default 0)
  jumpMean?: number; // mean log jump size (default 0)
  jumpVol?: number; // stdev of log jump size (default 0)
  days: number; // horizon in trading days
  paths?: number; // default 10000
  seed?: number; // default 42
};

export type SimulationResult = {
  terminalPrices: number[];
  pathMinima: number[]; // lowest close along each path (day 1..days)
};

/**
 * Simulate Merton jump-diffusion paths. Returns terminal prices and per-path
 * minima (for barrier/kill questions). Null on non-finite or non-positive
 * inputs rather than garbage paths.
 */
export function simulateMerton(params: JumpDiffusionParams): SimulationResult | null {
  const { spot, vol } = params;
  const mu = params.mu ?? 0;
  const lambda = params.jumpIntensity ?? 0;
  const jumpMean = params.jumpMean ?? 0;
  const jumpVol = params.jumpVol ?? 0;
  const days = Math.floor(params.days);
  const paths = Math.floor(params.paths ?? 10_000);
  const seed = params.seed ?? 42;

  if (!Number.isFinite(spot) || spot <= 0) return null;
  if (!Number.isFinite(vol) || vol < 0) return null;
  if (!Number.isFinite(mu) || !Number.isFinite(jumpMean)) return null;
  if (!Number.isFinite(lambda) || lambda < 0 || !Number.isFinite(jumpVol) || jumpVol < 0) return null;
  if (!Number.isFinite(days) || days < 1 || paths < 1) return null;

  const dt = 1 / TRADING_DAYS;
  const drift = (mu - lambda * jumpMean) * dt; // jump-compensated log drift
  const diffusion = vol * Math.sqrt(dt);
  const lambdaDt = lambda * dt;
  const rand = mulberry32(seed);
  const normal = gaussianSampler(rand);

  const terminalPrices = new Array<number>(paths);
  const pathMinima = new Array<number>(paths);
  const logSpot = Math.log(spot);
  for (let p = 0; p < paths; p++) {
    let logS = logSpot;
    let minLog = logSpot;
    for (let d = 0; d < days; d++) {
      let jump = 0;
      const n = poissonSample(rand, lambdaDt);
      for (let i = 0; i < n; i++) jump += jumpMean + jumpVol * normal();
      logS += drift + diffusion * normal() + jump;
      if (logS < minLog) minLog = logS;
    }
    terminalPrices[p] = Math.exp(logS);
    pathMinima[p] = Math.exp(minLog);
  }
  return { terminalPrices, pathMinima };
}

export type PositionRiskInput = {
  spot: number;
  killPrice: number | null; // thesis kill level; null when undefined
  targetPrice: number | null; // bull target; null when undefined
  days: number; // horizon in trading days
  vol: number | null; // annualized vol (e.g. GARCH forecast); falls back to realized
  history: number[]; // daily closes, oldest → newest — jump calibration source
  paths?: number;
  seed?: number;
};

export type PositionRisk = {
  pHitKillBeforeHorizon: number | null; // P(path minimum ≤ kill) — uses path minima, not terminal
  pAboveTarget: number | null; // P(terminal ≥ target)
  cvar95Pct: number; // mean of the worst 5% terminal returns, in % (negative)
  pDrawdown20: number; // P(path minimum ≤ −20% from spot)
  calibration: {
    diffusionVol: number; // annualized, after removing the jump variance share
    jumpIntensity: number; // jumps per year
    jumpMean: number; // mean log jump size
    jumpVol: number; // stdev of log jump size
  };
};

/**
 * Position risk from jump-diffusion paths, calibrated to the name's history:
 * jumps = daily log returns beyond 3σ; intensity = count/years; jump moments
 * from those days. Diffusion variance = vol² − λ(μ_J² + σ_J²) (Merton's total
 * variance decomposition), floored at 25% of vol² so jumps never swallow the
 * whole budget. Drift is 0 by design — this measures dispersion and tail
 * odds, not alpha. Null when neither vol nor enough history exists.
 */
export function positionRisk(input: PositionRiskInput): PositionRisk | null {
  const { spot, killPrice, targetPrice } = input;
  const days = Math.floor(input.days);
  if (!Number.isFinite(spot) || spot <= 0) return null;
  if (!Number.isFinite(days) || days < 1) return null;

  const logRets: number[] = [];
  for (let i = 1; i < input.history.length; i++) {
    const a = input.history[i - 1];
    const b = input.history[i];
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) logRets.push(Math.log(b / a));
  }

  let vol = input.vol;
  if (vol == null || !Number.isFinite(vol) || vol <= 0) {
    if (logRets.length < 40) return null;
    const m = logRets.reduce((s, x) => s + x, 0) / logRets.length;
    const variance = logRets.reduce((s, x) => s + (x - m) ** 2, 0) / (logRets.length - 1);
    vol = Math.sqrt(variance * TRADING_DAYS);
    if (!(vol > 0)) return null;
  }

  // Jump calibration: |daily log return − mean| > 3σ_daily counts as a jump.
  let jumpIntensity = 0;
  let jumpMean = 0;
  let jumpVol = 0;
  if (logRets.length >= 60) {
    const m = logRets.reduce((s, x) => s + x, 0) / logRets.length;
    const sd = Math.sqrt(logRets.reduce((s, x) => s + (x - m) ** 2, 0) / (logRets.length - 1));
    if (sd > 0) {
      const jumps = logRets.filter((x) => Math.abs(x - m) > 3 * sd);
      if (jumps.length > 0) {
        const years = logRets.length / TRADING_DAYS;
        jumpIntensity = jumps.length / years;
        jumpMean = jumps.reduce((s, x) => s + x, 0) / jumps.length;
        jumpVol =
          jumps.length > 1
            ? Math.sqrt(jumps.reduce((s, x) => s + (x - jumpMean) ** 2, 0) / (jumps.length - 1))
            : 0;
      }
    }
  }

  // Merton: total annual variance = σ_diff² + λ(μ_J² + σ_J²); back out σ_diff.
  const jumpVar = jumpIntensity * (jumpMean * jumpMean + jumpVol * jumpVol);
  const diffusionVol = Math.sqrt(Math.max(vol * vol - jumpVar, 0.25 * vol * vol));

  const sim = simulateMerton({
    spot,
    mu: 0,
    vol: diffusionVol,
    jumpIntensity,
    jumpMean,
    jumpVol,
    days,
    paths: input.paths,
    seed: input.seed,
  });
  if (!sim) return null;
  const { terminalPrices, pathMinima } = sim;
  const n = terminalPrices.length;

  let kill = 0;
  let above = 0;
  let dd20 = 0;
  const ddLevel = spot * 0.8;
  for (let i = 0; i < n; i++) {
    if (killPrice != null && pathMinima[i] <= killPrice) kill++;
    if (targetPrice != null && terminalPrices[i] >= targetPrice) above++;
    if (pathMinima[i] <= ddLevel) dd20++;
  }

  // CVaR-95: mean return of the worst 5% of terminal outcomes.
  const rets = terminalPrices.map((s) => s / spot - 1).sort((a, b) => a - b);
  const tail = Math.max(1, Math.floor(0.05 * n));
  let tailSum = 0;
  for (let i = 0; i < tail; i++) tailSum += rets[i];

  return {
    pHitKillBeforeHorizon: killPrice != null && Number.isFinite(killPrice) ? kill / n : null,
    pAboveTarget: targetPrice != null && Number.isFinite(targetPrice) ? above / n : null,
    cvar95Pct: (tailSum / tail) * 100,
    pDrawdown20: dd20 / n,
    calibration: { diffusionVol, jumpIntensity, jumpMean, jumpVol },
  };
}
