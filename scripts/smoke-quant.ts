import { computeNameQuant, computeBookQuant, correlationsVsBook, sizingMath, MANDATE } from "@/lib/quant";
import { getBenchmark } from "@/lib/market";

function assert(label: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  console.log("MANDATE:", MANDATE);

  for (const t of ["TSEM", "MU", "SPY"]) {
    let q;
    try {
      q = await computeNameQuant(t);
    } catch (e) {
      console.log(`\n${t} name quant: unavailable (${e instanceof Error ? e.message : e})`);
      if (t !== "SPY") process.exitCode = 1;
      continue;
    }
    console.log(`\n${t} name quant:`, {
      spot: q.spot,
      annualizedVol: q.annualizedVol?.toFixed(4),
      beta: q.beta?.toFixed(3),
      maxDrawdown: q.maxDrawdown?.toFixed(4),
      pctFrom52wHigh: q.pctFrom52wHigh?.toFixed(2),
      pctFrom52wLow: q.pctFrom52wLow?.toFixed(2),
      momentum3m: q.momentum3m?.toFixed(4),
      momentum6m: q.momentum6m?.toFixed(4),
      rsi14: q.rsi14?.toFixed(1),
      avgDollarVolume: q.avgDollarVolume?.toExponential(3),
      evToRevenue: q.evToRevenue?.toFixed(2),
      evToOperatingIncome: q.evToOperatingIncome?.toFixed(2),
      peRatio: q.peRatio?.toFixed(2),
      historyDays: q.historyDays,
    });
    if (q.rsi14 != null) assert(`${t} RSI within 0-100`, q.rsi14 >= 0 && q.rsi14 <= 100);
    if (q.maxDrawdown != null) assert(`${t} maxDrawdown ≤ 0`, q.maxDrawdown <= 0);
    if (q.pctFrom52wHigh != null) assert(`${t} ≤ 0 from 52w high`, q.pctFrom52wHigh <= 1e-9);
    if (t === "SPY" && q.beta != null) assert("SPY beta vs itself ≈ 1", Math.abs(q.beta - 1) < 1e-9);
  }

  const bench = await getBenchmark();
  console.log("\nbenchmark:", bench && { ticker: bench.ticker, price: bench.price, historyDays: bench.history.length, stale: bench.stale });
  assert("benchmark available", bench != null && bench.history.length >= 60);

  const book = await computeBookQuant();
  console.log("\nbook quant:", {
    navUsd: book.navUsd,
    grossExposurePct: book.grossExposurePct,
    weightedBeta: book.weightedBeta?.toFixed(3),
    bookAnnualizedVol: book.bookAnnualizedVol?.toFixed(4),
    cashPct: book.cashPct?.toFixed(1),
    worstDrawdownFromEntry: book.worstDrawdownFromEntry,
    themeConcentration: book.themeConcentration,
    correlationClusters: book.correlationClusters,
    positions: book.positions,
  });
  console.log("correlation matrix:", book.pairwiseCorrelations.tickers);
  for (const row of book.pairwiseCorrelations.matrix) {
    console.log("  ", row.map((c) => (c == null ? "  —  " : c.toFixed(3).padStart(6))).join(" "));
  }
  const flat = book.pairwiseCorrelations.matrix.flat().filter((c): c is number => c != null);
  assert("correlations within [-1,1]", flat.every((c) => c >= -1 && c <= 1));
  assert("diagonal = 1", book.pairwiseCorrelations.matrix.every((row, i) => row[i] === 1) || flat.length === 0);

  const vsBook = await correlationsVsBook("TSEM");
  console.log("\nTSEM correlations vs book:", vsBook);

  const tsem = await computeNameQuant("TSEM"); // snapshot-cached by the loop above
  const sizing = sizingMath({
    bearPrice: tsem.spot! * 0.75,
    basePrice: tsem.spot! * 1.25,
    bullPrice: tsem.spot! * 1.7,
    spot: tsem.spot!,
    annualizedVol: tsem.annualizedVol,
    advDollars: tsem.avgDollarVolume,
    navUsd: book.navUsd,
  });
  console.log("\nsizing (TSEM, bear -25% / base +25% / bull +70%):", {
    kellyPct: sizing.kellyPct.toFixed(2),
    kellyHalfPct: sizing.kellyHalfPct.toFixed(2),
    volTargetPct: sizing.volTargetPct?.toFixed(2),
    liquidityCapPct: sizing.liquidityCapPct?.toFixed(2),
    mandateCapPct: sizing.mandateCapPct,
    recommendedPct: sizing.recommendedPct.toFixed(2),
    bindingConstraint: sizing.bindingConstraint,
  });
  assert("recommended ≥ 0", sizing.recommendedPct >= 0);
  assert("recommended ≤ mandate cap", sizing.recommendedPct <= sizing.mandateCapPct + 1e-9);

  const noEdge = sizingMath({
    bearPrice: 50, basePrice: 90, bullPrice: 110, spot: 100,
    annualizedVol: 0.3, navUsd: book.navUsd,
  });
  assert("negative-edge Kelly clamps to 0", noEdge.kellyPct === 0 && noEdge.recommendedPct === 0);

  console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
