// Synthetic-recovery specs ported from scripts/smoke-mathlab.ts: does each
// estimator recover known truth? Deterministic (seeded RNG), no network/DB.
import { describe, it, expect } from "vitest";
import {
  riskNeutralDensity,
  probAbove,
  probBelow,
  impliedMovePct,
  tailAsymmetry,
  type ChainContract,
} from "@/lib/mathlab/rnd";
import { fitGarch, varianceRiskPremium } from "@/lib/mathlab/garch";
import { fitHMM, regimeRead } from "@/lib/mathlab/regime";
import { simulateMerton, positionRisk } from "@/lib/mathlab/montecarlo";
import { updatePosterior, lrFrom, MAX_ABS_LOG_LR } from "@/lib/mathlab/bayes";
import { gaussians, normCdf, bsCall, bsPut, trapezoid } from "./helpers";

describe("Breeden-Litzenberger RND (flat-vol BS chain must give back the lognormal)", () => {
  const SPOT = 100,
    T = 0.25,
    R = 0.04,
    SIGMA = 0.35;
  const FWD = SPOT * Math.exp(R * T);
  const DF = Math.exp(-R * T);
  const contracts: ChainContract[] = [];
  for (let k = 40; k <= 180; k += 5) {
    const type = k >= SPOT ? "C" : "P";
    const mid = type === "C" ? bsCall(FWD, k, SIGMA, T, DF) : bsPut(FWD, k, SIGMA, T, DF);
    contracts.push({ type, strike: k, mid, iv: SIGMA });
  }
  // Junk the filters must reject without breaking the fit:
  contracts.push({ type: "C", strike: 117, mid: 1.0, iv: 9 });
  contracts.push({ type: "P", strike: 63, mid: -1, iv: SIGMA });
  contracts.push({ type: "C", strike: 122, mid: null, iv: SIGMA });

  const rnd = riskNeutralDensity({ spot: SPOT, expiryYears: T, riskFreeRate: R, contracts });

  it("produces a density that integrates to ~1 with mean ≈ forward", () => {
    expect(rnd).not.toBeNull();
    const mass = trapezoid(rnd!.strikes, rnd!.density);
    const mean = trapezoid(rnd!.strikes, rnd!.strikes.map((k, i) => k * rnd!.density[i]));
    expect(Math.abs(mass - 1)).toBeLessThan(0.02);
    expect(Math.abs(mean / FWD - 1)).toBeLessThan(0.02);
    expect(rnd!.density.every((d) => d >= 0)).toBe(true);
  });

  it("matches the lognormal P(>spot), implied move, and right skew", () => {
    const pUp = probAbove(rnd!, SPOT);
    const exactPUp = normCdf((Math.log(FWD / SPOT) - (SIGMA * SIGMA * T) / 2) / (SIGMA * Math.sqrt(T)));
    expect(Math.abs(pUp - exactPUp)).toBeLessThan(0.02);
    expect(Math.abs(probAbove(rnd!, 110) + probBelow(rnd!, 110) - 1)).toBeLessThan(1e-9);
    const move = impliedMovePct(rnd!);
    const exactMove = Math.sqrt(Math.exp(SIGMA * SIGMA * T) - 1);
    expect(move).not.toBeNull();
    expect(Math.abs(move! / exactMove - 1)).toBeLessThan(0.15);
    const asym = tailAsymmetry(rnd!, SPOT);
    expect(asym).not.toBeNull();
    expect(asym!).toBeGreaterThan(1);
    expect(asym!).toBeLessThan(1.6);
  });

  it("rejects a thin chain (<6 usable strikes)", () => {
    expect(riskNeutralDensity({ spot: SPOT, expiryYears: T, contracts: contracts.slice(0, 5) })).toBeNull();
  });
});

describe("GARCH(1,1) parameter recovery", () => {
  const normal = gaussians(123);
  const omega = 2e-6,
    alphaTrue = 0.08,
    betaTrue = 0.9; // varLR = 1e-4 → σLR ≈ 15.9%
  let v = 1e-4;
  const rets: number[] = [];
  for (let i = 0; i < 2500; i++) {
    const r = Math.sqrt(v) * normal();
    rets.push(r);
    v = omega + alphaTrue * r * r + betaTrue * v;
  }

  it("recovers α+β, a sane α, and the long-run vol", () => {
    const g = fitGarch(rets);
    expect(g).not.toBeNull();
    expect(Math.abs(g!.alpha + g!.beta - 0.98)).toBeLessThan(0.04);
    expect(g!.alpha).toBeGreaterThan(0.02);
    expect(g!.alpha).toBeLessThan(0.16);
    expect(Math.abs(g!.longRunVolAnnualized - 0.1587)).toBeLessThan(0.03);
  });

  it("returns null on too-short input", () => {
    expect(fitGarch(rets.slice(0, 100))).toBeNull();
  });

  it("computes the variance risk premium", () => {
    const vrp = varianceRiskPremium(0.2, 0.23);
    expect(vrp).not.toBeNull();
    expect(Math.abs(vrp! - 0.15)).toBeLessThan(1e-12);
  });
});

describe("2-state HMM regime detection", () => {
  const normal = gaussians(7);
  const series: number[] = [];
  for (let i = 0; i < 400; i++) series.push(0.0004 + 0.008 * normal());
  for (let i = 0; i < 150; i++) series.push(-0.002 + 0.025 * normal());
  for (let i = 0; i < 150; i++) series.push(0.0004 + 0.008 * normal());

  it("orders states by vol and flags the stressed window", () => {
    const full = fitHMM(series);
    expect(full).not.toBeNull();
    expect(full!.vols[1]).toBeGreaterThan(full!.vols[0]);
    expect(full!.vols[1] / full!.vols[0]).toBeGreaterThan(2);
    expect(full!.pStressedNow).toBeLessThan(0.25); // ends calm
    const stressWindow = full!.viterbiPath.slice(410, 540);
    const fracStressed = stressWindow.reduce((s, x) => s + x, 0) / stressWindow.length;
    expect(fracStressed).toBeGreaterThan(0.7);
  });

  it("recognizes a known-stressed endpoint", () => {
    const midStress = fitHMM(series.slice(0, 480));
    expect(midStress).not.toBeNull();
    expect(midStress!.pStressedNow).toBeGreaterThan(0.6);
  });

  it("labels calm vs stressed endpoints and rejects short input", () => {
    expect(regimeRead(series)?.label).toBe("calm");
    expect(regimeRead(series.slice(0, 480))?.label).toBe("stressed");
    expect(fitHMM(series.slice(0, 100))).toBeNull();
  });
});

describe("Merton Monte Carlo", () => {
  const sim = simulateMerton({ spot: 100, mu: 0, vol: 0.3, days: 252, paths: 20000, seed: 11 });

  it("is unbiased for mu=0 and log-symmetric", () => {
    expect(sim).not.toBeNull();
    const n = sim!.terminalPrices.length;
    const pAboveSpot = sim!.terminalPrices.filter((s) => s > 100).length / n;
    const pUp10 = sim!.terminalPrices.filter((s) => s > 110).length / n;
    const pDn10 = sim!.terminalPrices.filter((s) => s < 100 / 1.1).length / n;
    expect(Math.abs(pAboveSpot - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(pUp10 - pDn10)).toBeLessThan(0.02);
  });

  it("is deterministic under a fixed seed and varies with a new one", () => {
    const same = simulateMerton({ spot: 100, mu: 0, vol: 0.3, days: 252, paths: 20000, seed: 11 });
    expect(same!.terminalPrices[0]).toBe(sim!.terminalPrices[0]);
    expect(same!.pathMinima[123]).toBe(sim!.pathMinima[123]);
    const diff = simulateMerton({ spot: 100, mu: 0, vol: 0.3, days: 252, paths: 20000, seed: 12 });
    expect(diff!.terminalPrices[0]).not.toBe(sim!.terminalPrices[0]);
  });

  it("calibrates jumps and bounds the kill/target/CVaR probabilities", () => {
    const normal = gaussians(31);
    const closes: number[] = [100];
    for (let i = 1; i <= 500; i++) {
      let step = (0.35 / Math.sqrt(252)) * normal();
      if (i % 100 === 50) step -= 0.08; // periodic -8% log jumps
      closes.push(closes[i - 1] * Math.exp(step));
    }
    const risk = positionRisk({ spot: 100, killPrice: 75, targetPrice: 130, days: 126, vol: 0.35, history: closes, paths: 8000, seed: 5 });
    expect(risk).not.toBeNull();
    expect(risk!.calibration.jumpIntensity).toBeGreaterThan(0);
    expect(risk!.pHitKillBeforeHorizon!).toBeGreaterThan(0);
    expect(risk!.pHitKillBeforeHorizon!).toBeLessThan(1);
    expect(risk!.pAboveTarget!).toBeGreaterThan(0);
    expect(risk!.pAboveTarget!).toBeLessThan(1);
    expect(risk!.cvar95Pct).toBeLessThan(0);
    expect(risk!.cvar95Pct).toBeGreaterThan(-90);
    expect(risk!.pHitKillBeforeHorizon!).toBeLessThanOrEqual(risk!.pDrawdown20 + 1e-12);
  });

  it("returns null on degenerate input", () => {
    expect(positionRisk({ spot: -5, killPrice: null, targetPrice: null, days: 10, vol: 0.3, history: [] })).toBeNull();
  });
});

describe("Bayesian fusion (log-odds with ln(3) cap)", () => {
  it("cancels symmetric evidence", () => {
    const cancel = updatePosterior(0.5, [
      { name: "bullish", likelihoodRatio: 2 },
      { name: "bearish", likelihoodRatio: 0.5 },
    ]);
    expect(cancel).not.toBeNull();
    expect(Math.abs(cancel!.posterior - 0.5)).toBeLessThan(1e-12);
  });

  it("binds the 3:1 cap on a single huge LR", () => {
    const capped = updatePosterior(0.5, [{ name: "huge", likelihoodRatio: 100 }]);
    expect(capped).not.toBeNull();
    expect(Math.abs(capped!.posterior - 0.75)).toBeLessThan(1e-12);
    expect(Math.abs(capped!.contributions[0].deltaLogOdds - MAX_ABS_LOG_LR)).toBeLessThan(1e-12);
  });

  it("ignores invalid LRs and rejects a NaN prior", () => {
    const junk = updatePosterior(0.6, [{ name: "junk", likelihoodRatio: -4 }]);
    expect(junk).not.toBeNull();
    expect(Math.abs(junk!.posterior - 0.6)).toBeLessThan(1e-12);
    expect(updatePosterior(Number.NaN, [])).toBeNull();
  });

  it("maps signal kinds to their documented likelihood ratios", () => {
    expect(lrFrom({ kind: "insider_cluster_buy", value: 2 })).toBe(1.8);
    expect(lrFrom({ kind: "short_pressure_z", value: 2.5 })).toBe(0.75);
    expect(lrFrom({ kind: "rnd_tail_asymmetry", value: 1.6 })).toBe(1.3);
    expect(lrFrom({ kind: "astrology", value: 99 })).toBe(1);
  });
});
