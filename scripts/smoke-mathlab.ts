// Math Lab smoke tests — synthetic recovery checks (does each estimator
// recover known truth?) plus real-data sections (MU history via getQuote,
// regime via computeRegime). Run: npx tsx scripts/smoke-mathlab.ts
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
import { simulateMerton, positionRisk, mulberry32 } from "@/lib/mathlab/montecarlo";
import { shrinkCovariance, multivariateKelly, cvarConstrainedScale } from "@/lib/mathlab/covariance";
import { updatePosterior, lrFrom, MAX_ABS_LOG_LR } from "@/lib/mathlab/bayes";
import { sizingMathMulti } from "@/lib/quant";
import { computeRegime } from "@/lib/warroom";
import { getQuote } from "@/lib/market";

function assert(label: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
}

// Local Black-Scholes for building the synthetic chain (mirrors rnd.ts internals).
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
function bsCall(f: number, k: number, vol: number, yrs: number, df: number): number {
  const sT = vol * Math.sqrt(yrs);
  const d1 = Math.log(f / k) / sT + sT / 2;
  return df * (f * normCdf(d1) - k * normCdf(d1 - sT));
}
function bsPut(f: number, k: number, vol: number, yrs: number, df: number): number {
  const sT = vol * Math.sqrt(yrs);
  const d1 = Math.log(f / k) / sT + sT / 2;
  return df * (k * normCdf(-(d1 - sT)) - f * normCdf(-d1));
}
function gaussians(seed: number): () => number {
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
function trapezoid(xs: number[], ys: number[]): number {
  let acc = 0;
  for (let i = 1; i < xs.length; i++) acc += ((ys[i - 1] + ys[i]) / 2) * (xs[i] - xs[i - 1]);
  return acc;
}

async function main() {
  // (a) RND: a flat-vol Black-Scholes chain must give back the lognormal.
  console.log("\n[a] Breeden-Litzenberger RND — synthetic BS chain (spot 100, T 0.25y, vol 0.35)");
  const SPOT = 100, T = 0.25, R = 0.04, SIGMA = 0.35;
  const FWD = SPOT * Math.exp(R * T);
  const DF = Math.exp(-R * T);
  const contracts: ChainContract[] = [];
  for (let k = 40; k <= 180; k += 5) {
    const type = k >= SPOT ? "C" : "P";
    const mid = type === "C" ? bsCall(FWD, k, SIGMA, T, DF) : bsPut(FWD, k, SIGMA, T, DF);
    contracts.push({ type, strike: k, mid, iv: SIGMA });
  }
  // Junk that the filters must reject without breaking the fit:
  contracts.push({ type: "C", strike: 117, mid: 1.0, iv: 9 }); // absurd IV
  contracts.push({ type: "P", strike: 63, mid: -1, iv: SIGMA }); // dead quote
  contracts.push({ type: "C", strike: 122, mid: null, iv: SIGMA }); // no mid

  const rnd = riskNeutralDensity({ spot: SPOT, expiryYears: T, riskFreeRate: R, contracts });
  assert("density produced", rnd != null);
  if (rnd) {
    const mass = trapezoid(rnd.strikes, rnd.density);
    const mean = trapezoid(rnd.strikes, rnd.strikes.map((k, i) => k * rnd.density[i]));
    const pUp = probAbove(rnd, SPOT);
    const exactPUp = normCdf((Math.log(FWD / SPOT) - (SIGMA * SIGMA * T) / 2) / (SIGMA * Math.sqrt(T)));
    const move = impliedMovePct(rnd);
    const exactMove = Math.sqrt(Math.exp(SIGMA * SIGMA * T) - 1); // lognormal stdev/mean
    const asym = tailAsymmetry(rnd, SPOT);
    console.log(
    `  mass=${mass.toFixed(4)} mean=${mean.toFixed(2)} (fwd ${FWD.toFixed(2)}) ` +
      `P(>spot)=${pUp.toFixed(4)} (exact ${exactPUp.toFixed(4)}) move=${move?.toFixed(4)} ` +
      `(exact ${exactMove.toFixed(4)}) tailAsym=${asym?.toFixed(3)}`,
    );
    assert("integrates to ~1 (±2%)", Math.abs(mass - 1) < 0.02);
    assert("mean ≈ forward (±2%)", Math.abs(mean / FWD - 1) < 0.02);
    assert("density ≥ 0 everywhere (monotone CDF)", rnd.density.every((d) => d >= 0));
    assert("P(above spot) matches lognormal ±0.02", Math.abs(pUp - exactPUp) < 0.02);
    assert("probAbove + probBelow = 1", Math.abs(probAbove(rnd, 110) + probBelow(rnd, 110) - 1) < 1e-9);
    assert("implied move ≈ lognormal (±15% rel)", move != null && Math.abs(move / exactMove - 1) < 0.15);
    assert("tail asymmetry > 1 (lognormal right skew)", asym != null && asym > 1 && asym < 1.6);
  }
  const thin = riskNeutralDensity({
    spot: SPOT,
    expiryYears: T,
    contracts: contracts.slice(0, 5),
  });
  assert("thin chain (<6 strikes) → null", thin == null);

  // (b) GARCH: parameter recovery on simulated data, then real MU returns.
  console.log("\n[b] GARCH(1,1) — recovery on simulated data (α 0.08, β 0.90, σLR ~15.9%)");
  {
    const normal = gaussians(123);
    const omega = 2e-6, alphaTrue = 0.08, betaTrue = 0.9; // varLR = 1e-4
    let v = 1e-4;
    const rets: number[] = [];
    for (let i = 0; i < 2500; i++) {
      const r = Math.sqrt(v) * normal();
      rets.push(r);
      v = omega + alphaTrue * r * r + betaTrue * v;
    }
    const g = fitGarch(rets);
    assert("fit produced", g != null);
    if (g) {
      console.log(
        `  alpha=${g.alpha.toFixed(4)} beta=${g.beta.toFixed(4)} (α+β=${(g.alpha + g.beta).toFixed(4)}, true 0.98) ` +
          `longRunVol=${g.longRunVolAnnualized.toFixed(4)} forecast30d=${g.forecastVol30dAnnualized.toFixed(4)}`,
      );
      assert("α+β within 0.04 of truth", Math.abs(g.alpha + g.beta - 0.98) < 0.04);
      assert("α in a sane band", g.alpha > 0.02 && g.alpha < 0.16);
      assert("long-run vol ≈ 15.9% (±3pp)", Math.abs(g.longRunVolAnnualized - 0.1587) < 0.03);
    }
    assert("short input → null", fitGarch(rets.slice(0, 100)) == null);
    const vrp = varianceRiskPremium(0.2, 0.23);
    assert("variance risk premium = 0.15", vrp != null && Math.abs(vrp - 0.15) < 1e-12);
  }

  console.log("\n[b2] GARCH on real MU history (getQuote)");
  {
    const mu = await getQuote("MU").catch(() => null);
    if (!mu || mu.history.length < 251) {
      console.log("  MU history unavailable (no live fetch, no cache) — skipping real-data GARCH");
    } else {
      const rets: number[] = [];
      for (let i = 1; i < mu.history.length; i++) rets.push(mu.history[i] / mu.history[i - 1] - 1);
      const g = fitGarch(rets);
      const last21 = rets.slice(-21);
      const m21 = last21.reduce((s, x) => s + x, 0) / last21.length;
      const realized21 = Math.sqrt(
        (last21.reduce((s, x) => s + (x - m21) ** 2, 0) / (last21.length - 1)) * 252,
      );
      console.log(
        `  MU: ${mu.history.length} closes, stale=${mu.stale} (fetched ${mu.fetchedAt.toISOString()})`,
      );
      if (g) {
        console.log(
          `  GARCH: α=${g.alpha.toFixed(3)} β=${g.beta.toFixed(3)} longRun=${(g.longRunVolAnnualized * 100).toFixed(1)}% ` +
            `forecast30d=${(g.forecastVol30dAnnualized * 100).toFixed(1)}% vs realized21d=${(realized21 * 100).toFixed(1)}%`,
        );
        assert("MU fit produced with sane vols", g.forecastVol30dAnnualized > 0.1 && g.forecastVol30dAnnualized < 2);
        assert("MU α+β stationary", g.alpha + g.beta < 0.999);
      } else {
        assert("MU fit produced", false);
      }
    }
  }

  // (c) HMM: two synthetic regimes — must find the vol ordering and flag the stressed window.
  console.log("\n[c] 2-state HMM — synthetic regimes (400 calm, 150 stressed, 150 calm)");
  {
    const normal = gaussians(7);
    const series: number[] = [];
    for (let i = 0; i < 400; i++) series.push(0.0004 + 0.008 * normal());
    for (let i = 0; i < 150; i++) series.push(-0.002 + 0.025 * normal());
    for (let i = 0; i < 150; i++) series.push(0.0004 + 0.008 * normal());

    const full = fitHMM(series);
    assert("fit produced", full != null);
    if (full) {
      console.log(
        `  vols=[${full.vols[0].toFixed(4)}, ${full.vols[1].toFixed(4)}] (true 0.008/0.025) ` +
          `t11=${full.transition[1][1].toFixed(3)} pStressedNow=${full.pStressedNow.toFixed(4)}`,
      );
      assert("state 1 is the higher-vol state", full.vols[1] > full.vols[0]);
      assert("vol separation found (ratio > 2)", full.vols[1] / full.vols[0] > 2);
      assert("series ends calm → pStressedNow < 0.25", full.pStressedNow < 0.25);
      const stressWindow = full.viterbiPath.slice(410, 540);
      const fracStressed = stressWindow.reduce((s, x) => s + x, 0) / stressWindow.length;
      assert("viterbi labels the stressed window (>70%)", fracStressed > 0.7);
    }
    const midStress = fitHMM(series.slice(0, 480)); // ends 80 days into the stressed regime
    assert("known-stressed endpoint → pStressedNow > 0.6", midStress != null && midStress.pStressedNow > 0.6);

    const readCalm = regimeRead(series);
    const readStress = regimeRead(series.slice(0, 480));
    console.log(
      `  regimeRead(end calm): ${readCalm?.label} p=${readCalm?.pStressed.toFixed(3)} ` +
        `dur=${readCalm?.expectedStressDurationDays.toFixed(1)}d | (end stressed): ${readStress?.label} p=${readStress?.pStressed.toFixed(3)}`,
    );
    assert("regimeRead labels calm endpoint", readCalm?.label === "calm");
    assert("regimeRead labels stressed endpoint", readStress?.label === "stressed");
    assert(
      "expected stress duration positive/finite",
      readCalm != null && readCalm.expectedStressDurationDays > 0 && readCalm.expectedStressDurationDays <= 1000,
    );
    assert("short input → null", fitHMM(series.slice(0, 100)) == null);
  }

  // (d) Monte Carlo: GBM sanity, put-call symmetry, determinism, position risk.
  console.log("\n[d] Merton Monte Carlo — GBM sanity (mu 0, vol 0.3, 1y, 20k paths)");
  {
    const sim = simulateMerton({ spot: 100, mu: 0, vol: 0.3, days: 252, paths: 20000, seed: 11 });
    assert("simulation produced", sim != null);
    if (sim) {
      const n = sim.terminalPrices.length;
      const pAboveSpot = sim.terminalPrices.filter((s) => s > 100).length / n;
      const pUp10 = sim.terminalPrices.filter((s) => s > 110).length / n;
      const pDn10 = sim.terminalPrices.filter((s) => s < 100 / 1.1).length / n;
      console.log(
        `  P(>spot)=${pAboveSpot.toFixed(4)} | put-call symmetry P(>110)=${pUp10.toFixed(4)} vs P(<90.91)=${pDn10.toFixed(4)}`,
      );
      assert("P(above spot) ≈ 0.5 ± 0.02 for mu=0", Math.abs(pAboveSpot - 0.5) < 0.02);
      assert("put-call (log) symmetry within 0.02", Math.abs(pUp10 - pDn10) < 0.02);
      const sim2 = simulateMerton({ spot: 100, mu: 0, vol: 0.3, days: 252, paths: 20000, seed: 11 });
      assert(
        "seeded determinism (same seed → same paths)",
        sim2 != null &&
          sim2.terminalPrices[0] === sim.terminalPrices[0] &&
          sim2.terminalPrices[n - 1] === sim.terminalPrices[n - 1] &&
          sim2.pathMinima[123] === sim.pathMinima[123],
      );
      const sim3 = simulateMerton({ spot: 100, mu: 0, vol: 0.3, days: 252, paths: 20000, seed: 12 });
      assert("different seed → different paths", sim3 != null && sim3.terminalPrices[0] !== sim.terminalPrices[0]);
    }

    // positionRisk on a synthetic jumpy history (vol ~0.35 + five -8% log jumps).
    const normal = gaussians(31);
    const closes: number[] = [100];
    for (let i = 1; i <= 500; i++) {
      let step = (0.35 / Math.sqrt(252)) * normal();
      if (i % 100 === 50) step -= 0.08;
      closes.push(closes[i - 1] * Math.exp(step));
    }
    const risk = positionRisk({
      spot: 100, killPrice: 75, targetPrice: 130, days: 126,
      vol: 0.35, history: closes, paths: 8000, seed: 5,
    });
    assert("positionRisk produced", risk != null);
    if (risk) {
      console.log(
        `  pHitKill(75)=${risk.pHitKillBeforeHorizon?.toFixed(4)} pAboveTarget(130)=${risk.pAboveTarget?.toFixed(4)} ` +
          `cvar95=${risk.cvar95Pct.toFixed(1)}% pDD20=${risk.pDrawdown20.toFixed(4)}`,
      );
      console.log(
        `  calibration: diffVol=${risk.calibration.diffusionVol.toFixed(3)} λ=${risk.calibration.jumpIntensity.toFixed(2)}/yr ` +
          `jumpMean=${risk.calibration.jumpMean.toFixed(4)} jumpVol=${risk.calibration.jumpVol.toFixed(4)}`,
      );
      assert("jumps calibrated from history (λ > 0)", risk.calibration.jumpIntensity > 0);
      assert("pHitKill in (0,1)", risk.pHitKillBeforeHorizon != null && risk.pHitKillBeforeHorizon > 0 && risk.pHitKillBeforeHorizon < 1);
      assert("pAboveTarget in (0,1)", risk.pAboveTarget != null && risk.pAboveTarget > 0 && risk.pAboveTarget < 1);
      assert("CVaR-95 negative", risk.cvar95Pct < 0 && risk.cvar95Pct > -90);
      assert("kill(−25%) ≤ drawdown(−20%) prob", (risk.pHitKillBeforeHorizon ?? 0) <= risk.pDrawdown20 + 1e-12);
    }
    assert("degenerate input → null", positionRisk({ spot: -5, killPrice: null, targetPrice: null, days: 10, vol: 0.3, history: [] }) == null);
  }

  // (e) Ledoit-Wolf + multivariate Kelly + CVaR governor.
  console.log("\n[e] Ledoit-Wolf shrinkage + multivariate Kelly (3 correlated assets, 300 obs)");
  {
    const normal = gaussians(99);
    const a: number[] = [], b: number[] = [], c: number[] = [];
    for (let i = 0; i < 300; i++) {
      const common = normal();
      a.push(0.01 * common);
      b.push(0.01 * (0.6 * common + 0.8 * normal()));
      c.push(0.012 * normal());
    }
    const matrix = [a, b, c];
    const shrunk = shrinkCovariance(matrix);
    assert("shrinkage produced", shrunk != null);
    if (shrunk) {
      console.log(
        `  shrinkage=${shrunk.shrinkage.toFixed(4)} diag=[${shrunk.cov.map((r, i) => r[i].toExponential(2)).join(", ")}]`,
      );
      assert("shrinkage in [0,1]", shrunk.shrinkage >= 0 && shrunk.shrinkage <= 1);
      let symmetric = true, posDiag = true;
      for (let i = 0; i < 3; i++) {
        if (shrunk.cov[i][i] <= 0) posDiag = false;
        for (let j = 0; j < 3; j++) {
          if (Math.abs(shrunk.cov[i][j] - shrunk.cov[j][i]) > 1e-15) symmetric = false;
        }
      }
      assert("cov symmetric", symmetric);
      assert("cov diagonals positive", posDiag);

      const capped = multivariateKelly({
        expectedReturns: [0.0008, 0.0006, 0.0004], cov: shrunk.cov, capPerName: 0.08, grossCap: 0.9,
      });
      assert("kelly produced", capped != null);
      if (capped) {
        console.log(`  capped kelly weights: [${capped.map((w) => w.toFixed(4)).join(", ")}]`);
        assert("per-name cap respected", capped.every((w) => w >= 0 && w <= 0.08 + 1e-12));
        assert("gross cap respected", capped.reduce((s, w) => s + w, 0) <= 0.9 + 1e-12);
        assert("strong edge pins the cap", capped[0] >= 0.08 - 1e-9);
      }
      const interior = multivariateKelly({
        expectedReturns: [5e-6, 4e-6, 3e-6], cov: shrunk.cov, capPerName: 0.08, grossCap: 0.9,
      });
      assert(
        "weak edge stays interior",
        interior != null && interior.every((w) => w < 0.08) && interior.some((w) => w > 0),
      );

      const tight = cvarConstrainedScale([0.5, 0.3, 0.2], matrix, 0.2);
      const loose = cvarConstrainedScale([0.5, 0.3, 0.2], matrix, 50);
      console.log(`  cvar scale: tight(0.2%)=${tight?.toFixed(4)} loose(50%)=${loose?.toFixed(4)}`);
      assert("tight CVaR limit scales down", tight != null && tight > 0 && tight < 1);
      assert("loose CVaR limit is slack (=1)", loose === 1);
    }
    assert("singular/short input → null", shrinkCovariance([[0.01, 0.02]]) == null);
  }

  // (f) Bayes: symmetric evidence cancels; the 3:1 cap binds.
  console.log("\n[f] Bayesian fusion — log-odds with ln(3) cap");
  {
    const cancel = updatePosterior(0.5, [
      { name: "bullish", likelihoodRatio: 2 },
      { name: "bearish", likelihoodRatio: 0.5 },
    ]);
    assert("symmetric evidence cancels (posterior 0.5)", cancel != null && Math.abs(cancel.posterior - 0.5) < 1e-12);

    const capped = updatePosterior(0.5, [{ name: "huge", likelihoodRatio: 100 }]);
    console.log(
      `  prior 0.5 + LR100 → posterior ${capped?.posterior.toFixed(4)} (cap ⇒ 0.75), ` +
        `delta=${capped?.contributions[0].deltaLogOdds.toFixed(4)} (ln3=${MAX_ABS_LOG_LR.toFixed(4)})`,
    );
    assert("cap binds at 3:1 (posterior 0.75)", capped != null && Math.abs(capped.posterior - 0.75) < 1e-12);
    assert(
      "contribution capped at ln(3)",
      capped != null && Math.abs(capped.contributions[0].deltaLogOdds - MAX_ABS_LOG_LR) < 1e-12,
    );
    const junk = updatePosterior(0.6, [{ name: "junk", likelihoodRatio: -4 }]);
    assert("invalid LR contributes nothing", junk != null && Math.abs(junk.posterior - 0.6) < 1e-12);
    assert("NaN prior → null", updatePosterior(Number.NaN, []) == null);

    assert("lrFrom: insider cluster buy (2 buyers) → 1.8", lrFrom({ kind: "insider_cluster_buy", value: 2 }) === 1.8);
    assert("lrFrom: short pressure z=2.5 → 0.75", lrFrom({ kind: "short_pressure_z", value: 2.5 }) === 0.75);
    assert("lrFrom: RND tail asym 1.6 → 1.3", lrFrom({ kind: "rnd_tail_asymmetry", value: 1.6 }) === 1.3);
    assert("lrFrom: unknown kind → 1", lrFrom({ kind: "astrology", value: 99 }) === 1);
  }

  // (g) Integrations: sizingMathMulti (pure) and the HMM-backed regime (real data).
  console.log("\n[g] Integrations — sizingMathMulti + computeRegime");
  {
    const normal = gaussians(55);
    const cand: number[] = [], b1: number[] = [], b2: number[] = [];
    for (let i = 0; i < 250; i++) {
      const common = normal();
      cand.push(0.012 * (0.5 * common + 0.86 * normal()));
      b1.push(0.01 * common);
      b2.push(0.011 * (0.3 * common + 0.95 * normal()));
    }
    const multi = sizingMathMulti({
      candidateReturns: cand,
      bookReturnsMatrix: [b1, b2],
      expectedReturns: [0.0006, 0.0003, 0.0002], // ~15%/8%/5% annualized edges
    });
    assert("sizingMathMulti produced", multi != null);
    if (multi) {
      console.log(
        `  candidate=${multi.candidatePct.toFixed(2)}% weights=[${multi.weightsPct.map((w) => w.toFixed(2)).join(", ")}]% ` +
          `shrinkage=${multi.shrinkage.toFixed(3)} cvarScale=${multi.cvarScale.toFixed(3)} binding=${multi.bindingConstraint}`,
      );
      assert("candidate ≤ mandate cap", multi.candidatePct <= 8 + 1e-9);
      assert("all weights non-negative", multi.weightsPct.every((w) => w >= 0));
      assert("cvarScale in (0,1]", multi.cvarScale > 0 && multi.cvarScale <= 1);
    }
    assert(
      "negative edge → zero candidate",
      (() => {
        const out = sizingMathMulti({
          candidateReturns: cand,
          bookReturnsMatrix: [b1, b2],
          expectedReturns: [-0.001, -0.001, -0.001],
        });
        return out != null && out.candidatePct === 0;
      })(),
    );
    assert(
      "mismatched expectedReturns → null",
      sizingMathMulti({ candidateReturns: cand, bookReturnsMatrix: [b1], expectedReturns: [0.1, 0.1, 0.1] }) == null,
    );

    const regime = await computeRegime();
    console.log(
      `  computeRegime: benchmark=${regime.benchmark} trend=${regime.trend} volRegime=${regime.volRegime} ` +
        `pStressed=${regime.pStressed == null ? "—" : regime.pStressed.toFixed(4)} read=${regime.read}`,
    );
    assert(
      "regime read is a known value",
      ["risk_on", "neutral", "risk_off", "unknown"].includes(regime.read),
    );
    if (regime.benchmark !== "—") {
      assert("HMM pStressed present with real benchmark", regime.pStressed != null && regime.pStressed >= 0 && regime.pStressed <= 1);
    }
  }

  console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
