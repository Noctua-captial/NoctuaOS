import { getQuote, getQuotes } from "@/lib/market";
import { getFundamentals } from "@/lib/fundamentals";

async function main() {
  for (const t of ["TSEM", "MU"]) {
    const q = await getQuote(t);
    console.log(t, "quote:", q && {
      price: q.price,
      prevClose: q.prevClose,
      dayChangePct: q.dayChangePct?.toFixed(2),
      currency: q.currency,
      historyLen: q.history.length,
      stale: q.stale,
    });
    const f = await getFundamentals(t);
    console.log(t, "fundamentals:", f && {
      revenue: f.revenue,
      operatingIncome: f.operatingIncome,
      netIncome: f.netIncome,
      shares: f.sharesOutstanding,
      cash: f.cash,
      debt: f.debt,
      fiscalPeriod: f.fiscalPeriod,
    });
  }
  const batch = await getQuotes(["TSEM", "MU"]);
  console.log("batch keys:", [...batch.keys()]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
