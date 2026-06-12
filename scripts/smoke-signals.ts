// Live smoke for the signal layer: refreshSignals against real CBOE / FINRA /
// EDGAR / Google News endpoints for TSEM and MU, plus the CBOE quote fallback.
import { refreshSignals } from "@/lib/signals";
import { fetchCboe, getQuote } from "@/lib/market";

function assert(label: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
}

const fin = (v: number | null) => v == null || Number.isFinite(v);

async function main() {
  for (const [t, name] of [
    ["TSEM", "Tower Semiconductor"],
    ["MU", "Micron Technology"],
  ] as const) {
    console.log(`\n=== ${t} (${name}) ===`);
    const snap = await refreshSignals(t, name);
    console.log("refreshedAt:", snap.refreshedAt);
    if (snap.errors.length > 0) console.log("source errors:", snap.errors);

    const o = snap.options;
    console.log(`${t} options:`, o && {
      asOf: o.asOf,
      spot: o.spot,
      iv30: o.iv30?.toFixed(4),
      putCallVolumeRatio: o.putCallVolumeRatio?.toFixed(4),
      putCallOiRatio: o.putCallOiRatio?.toFixed(4),
      skew25Delta: o.skew25Delta?.toFixed(4),
      termSlope: o.termSlope?.toFixed(4),
      impliedEarningsMovePct: o.impliedEarningsMovePct?.toFixed(2),
      unusualVolumeZ: o.unusualVolumeZ?.toFixed(2) ?? null,
      gex: o.gex?.toExponential(3),
      totalVolume: o.totalVolume,
      totalOpenInterest: o.totalOpenInterest,
      contractCount: o.contractCount,
    });
    assert(`${t} options present`, o != null);
    if (o) {
      assert(`${t} spot > 0`, o.spot != null && o.spot > 0);
      assert(`${t} P/C volume ratio finite and > 0`, o.putCallVolumeRatio == null || (Number.isFinite(o.putCallVolumeRatio) && o.putCallVolumeRatio > 0));
      assert(`${t} P/C OI ratio finite and > 0`, o.putCallOiRatio == null || (Number.isFinite(o.putCallOiRatio) && o.putCallOiRatio > 0));
      assert(`${t} skew25Delta within ±1`, o.skew25Delta == null || Math.abs(o.skew25Delta) <= 1);
      assert(`${t} termSlope finite`, fin(o.termSlope));
      assert(`${t} implied move > 0`, o.impliedEarningsMovePct == null || o.impliedEarningsMovePct > 0);
      assert(`${t} iv30 in (0, 5)`, o.iv30 == null || (o.iv30 > 0 && o.iv30 < 5));
      assert(`${t} gex finite`, fin(o.gex));
      assert(`${t} unusualVolumeZ null on day one (no fabricated history)`, fin(o.unusualVolumeZ));
    }

    const s = snap.short;
    console.log(`${t} short:`, s && {
      asOf: s.asOf,
      ratio: s.ratio.toFixed(4),
      trend: s.trend?.toFixed(4) ?? null,
      z: s.z?.toFixed(2) ?? null,
      daysOfHistory: s.daysOfHistory,
    });
    assert(`${t} short signal present`, s != null);
    if (s) {
      assert(`${t} short ratio in [0,1]`, s.ratio >= 0 && s.ratio <= 1);
      assert(`${t} short z honest (null below 10 stored days)`, s.daysOfHistory >= 10 || s.z == null);
    }

    const i = snap.insider;
    console.log(`${t} insider:`, i && {
      asOf: i.asOf,
      filingsChecked: i.filingsChecked,
      transactions: i.transactions.length,
      buyValue: Math.round(i.buyValue),
      sellValue: Math.round(i.sellValue),
      netValue: Math.round(i.netValue),
      clusterBuy: i.clusterBuy,
      distinctBuyers: i.distinctBuyers,
    });
    if (i && i.transactions.length > 0) {
      console.log(`${t} insider sample:`, i.transactions.slice(0, 3).map((tx) => `${tx.date} ${tx.insider} ${tx.code} ${tx.shares ?? "?"} @ ${tx.pricePerShare ?? "?"}`));
    }
    assert(`${t} insider present`, i != null);
    if (i) {
      assert(`${t} insider net = buys - sells`, Math.abs(i.netValue - (i.buyValue - i.sellValue)) < 1e-6);
      assert(`${t} insider values finite`, Number.isFinite(i.buyValue) && Number.isFinite(i.sellValue));
      assert(`${t} insider capped at 10 filings`, i.filingsChecked <= 10);
    }

    const n = snap.news;
    console.log(`${t} news:`, n && {
      asOf: n.asOf,
      items: n.items.length,
      newCount: n.newCount,
      burstCount: n.burstCount,
      burst: n.burst,
      classifiedCount: n.classifiedCount,
      tags: n.items.reduce<Record<string, number>>((acc, it) => {
        acc[it.tag] = (acc[it.tag] ?? 0) + 1;
        return acc;
      }, {}),
    });
    if (n && n.items.length > 0) {
      console.log(`${t} headlines:`, n.items.slice(0, 3).map((it) => `[${it.tag}] ${it.title.slice(0, 90)}`));
    }
    assert(`${t} news present`, n != null);
    if (n) {
      assert(`${t} news items have title+url`, n.items.every((it) => it.title.length > 0 && it.url.startsWith("http")));
      assert(`${t} burst flag matches count`, n.burst === (n.burstCount >= 4));
    }
  }

  console.log("\n=== CBOE quote fallback ===");
  for (const t of ["TSEM", "MU"]) {
    const direct = await fetchCboe(t);
    console.log(`${t} fetchCboe:`, {
      price: direct.price,
      prevClose: direct.prevClose,
      dayChangePct: direct.dayChangePct?.toFixed(2),
      historyLen: direct.history.length,
    });
    assert(`${t} CBOE price > 0`, direct.price > 0);
    assert(`${t} CBOE history empty by design`, direct.history.length === 0);

    const q = await getQuote(t);
    console.log(`${t} getQuote:`, q && {
      price: q.price,
      dayChangePct: q.dayChangePct?.toFixed(2),
      historyLen: q.history.length,
      stale: q.stale,
      note: q.note ?? null,
    });
    assert(`${t} getQuote returns a quote`, q != null && q.price > 0);
  }

  console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
