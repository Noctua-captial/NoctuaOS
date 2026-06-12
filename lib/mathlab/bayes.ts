// Bayesian fusion in log-odds space: posterior log-odds = prior log-odds +
// Σ ln(LR_i). Every |ln LR| is capped at ln 3 — no single signal may move
// the odds by more than 3:1. This is an honesty constraint: our likelihood
// ratios are calibrated priors, not measured frequencies, and uncapped
// products of guessed LRs manufacture false conviction.

export const MAX_ABS_LOG_LR = Math.log(3);

export type Evidence = {
  name: string;
  likelihoodRatio: number; // P(evidence | bull) / P(evidence | not bull)
};

export type Contribution = {
  name: string;
  lr: number; // the LR actually applied (1 when the input was invalid)
  deltaLogOdds: number; // capped ln(LR) added to the log-odds
};

export type PosteriorUpdate = {
  posterior: number;
  contributions: Contribution[];
};

/**
 * Update P(thesis) with a set of evidences in log-odds space. The prior is
 * clamped to [0.001, 0.999] — honest priors are never 0 or 1, and the clamp
 * keeps log-odds finite. Invalid LRs (≤ 0, NaN) contribute exactly nothing
 * and are recorded as lr = 1 so the ledger shows what was actually applied.
 */
export function updatePosterior(priorP: number, evidences: Evidence[]): PosteriorUpdate | null {
  if (!Number.isFinite(priorP)) return null;
  const p = Math.min(Math.max(priorP, 0.001), 0.999);
  let logOdds = Math.log(p / (1 - p));

  const contributions: Contribution[] = [];
  for (const e of evidences) {
    const valid = Number.isFinite(e.likelihoodRatio) && e.likelihoodRatio > 0;
    const delta = valid
      ? Math.min(Math.max(Math.log(e.likelihoodRatio), -MAX_ABS_LOG_LR), MAX_ABS_LOG_LR)
      : 0;
    contributions.push({ name: e.name, lr: valid ? e.likelihoodRatio : 1, deltaLogOdds: delta });
    logOdds += delta;
  }

  return { posterior: 1 / (1 + Math.exp(-logOdds)), contributions };
}

export type SignalReading = {
  kind: string;
  value: number;
};

/**
 * Signal strength → likelihood ratio for the bull thesis. These are
 * conservative, literature-flavored PRIORS — not fitted to outcomes yet —
 * and are meant to be re-tuned once directives accumulate a track record.
 * Every value stays well inside the 3:1 cap. Unknown kinds map to 1
 * (no evidence), never to a guess.
 *
 * kind                       value                                LR rationale
 * insider_cluster_buy        distinct insider buyers in 14d       ≥2 → 1.8 (cluster buys predict abnormal returns — Cohen, Malloy & Pomorski 2012 flavor)
 * insider_cluster_sell       distinct insider sellers in 14d      ≥2 → 0.85 (sells are weak evidence — often liquidity, not information)
 * short_pressure_z           z of short-volume ratio vs 60d       ≥2 → 0.75, ≤−2 → 1.2 (elevated shorting pressures price; literature on short-sale flow is directionally bearish)
 * rnd_tail_asymmetry         P(+20%)/P(−20%) from the RND         ≥1.5 → 1.3, ≤0.67 → 0.77 (option-implied skew in the thesis direction)
 * variance_risk_premium      (iv30 − GARCH forecast)/forecast     ≥0.3 → 0.9, ≤−0.2 → 1.05 (rich implied vol = hedging demand; weakly informative)
 * regime_stressed            pStressed from the HMM               ≥0.6 → 0.8, ≤0.25 → 1.1 (long theses underperform in stressed regimes)
 * unusual_options_volume_z   z of option volume vs history        ≥2 → 1.15 (attention/positioning; direction-agnostic so kept mild)
 * news_sentiment             classified sentiment in [−1, 1]      ≥0.5 → 1.15, ≤−0.5 → 0.85 (headline flow, weakly informative)
 */
export function lrFrom(signal: SignalReading): number {
  const v = signal.value;
  if (!Number.isFinite(v)) return 1;
  switch (signal.kind) {
    case "insider_cluster_buy":
      return v >= 2 ? 1.8 : v >= 1 ? 1.25 : 1;
    case "insider_cluster_sell":
      return v >= 2 ? 0.85 : 1;
    case "short_pressure_z":
      return v >= 2 ? 0.75 : v >= 1 ? 0.9 : v <= -2 ? 1.2 : v <= -1 ? 1.05 : 1;
    case "rnd_tail_asymmetry":
      return v >= 1.5 ? 1.3 : v >= 1.2 ? 1.1 : v <= 1 / 1.5 ? 0.77 : v <= 1 / 1.2 ? 0.9 : 1;
    case "variance_risk_premium":
      return v >= 0.3 ? 0.9 : v <= -0.2 ? 1.05 : 1;
    case "regime_stressed":
      return v >= 0.6 ? 0.8 : v <= 0.25 ? 1.1 : 1;
    case "unusual_options_volume_z":
      return v >= 2 ? 1.15 : 1;
    case "news_sentiment":
      return v >= 0.5 ? 1.15 : v <= -0.5 ? 0.85 : 1;
    default:
      return 1;
  }
}
