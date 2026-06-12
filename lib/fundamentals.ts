// Fundamentals from SEC EDGAR XBRL companyfacts — free, no API key.
// Cached in the `fundamentals` table with a ~24h TTL. Best-effort: any
// individual figure may be null (foreign filers, missing tags, etc.).
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { tickerToCik } from "@/lib/edgar";

const TTL_MS = 24 * 60 * 60 * 1000;

// Same User-Agent pattern as lib/edgar.ts — SEC requires a descriptive UA.
const UA = process.env.EDGAR_USER_AGENT ?? "NoctuaOS research internal@noctua.local";
const headers = { "User-Agent": UA, "Accept-Encoding": "gzip" };

export type Fundamentals = {
  ticker: string;
  revenue: number | null; // most recent annual, raw $
  operatingIncome: number | null;
  netIncome: number | null;
  sharesOutstanding: number | null;
  cash: number | null;
  debt: number | null;
  fiscalPeriod: string | null;
  fetchedAt: Date;
};

type FactEntry = {
  start?: string;
  end?: string;
  val?: number;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
};

type Facts = Record<string, Record<string, { units?: Record<string, FactEntry[]> }>>;

function entriesFor(facts: Facts, taxonomy: string, tag: string, units: string[]): FactEntry[] {
  const unitMap = facts?.[taxonomy]?.[tag]?.units;
  if (!unitMap) return [];
  for (const u of units) if (unitMap[u]?.length) return unitMap[u];
  return [];
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
}

/** Latest annual (≈12-month duration) value for a flow concept like revenue. */
function latestAnnual(entries: FactEntry[]): FactEntry | null {
  let best: FactEntry | null = null;
  for (const e of entries) {
    if (typeof e.val !== "number" || !e.end) continue;
    if (!e.start || daysBetween(e.start, e.end) < 330 || daysBetween(e.start, e.end) > 400) continue;
    if (!best || e.end > best.end! || (e.end === best.end && (e.filed ?? "") > (best.filed ?? ""))) {
      best = e;
    }
  }
  return best;
}

/** Latest point-in-time value for an instant concept like cash or shares. */
function latestInstant(entries: FactEntry[]): FactEntry | null {
  let best: FactEntry | null = null;
  for (const e of entries) {
    if (typeof e.val !== "number" || !e.end) continue;
    if (!best || e.end > best.end! || (e.end === best.end && (e.filed ?? "") > (best.filed ?? ""))) {
      best = e;
    }
  }
  return best;
}

// Companies migrate between tags over time (e.g. Revenues →
// RevenueFromContractWithCustomerExcludingAssessedTax post-ASC 606), so pick
// the most recent period across all candidate tags rather than the first tag with a hit.
function newest(candidates: (FactEntry | null)[]): FactEntry | null {
  let best: FactEntry | null = null;
  for (const e of candidates) {
    if (!e?.end) continue;
    if (!best || e.end > best.end!) best = e;
  }
  return best;
}

function firstAnnual(facts: Facts, taxonomy: string, tags: string[], units: string[]): FactEntry | null {
  return newest(tags.map((tag) => latestAnnual(entriesFor(facts, taxonomy, tag, units))));
}

function firstInstant(facts: Facts, taxonomy: string, tags: string[], units: string[]): FactEntry | null {
  return newest(tags.map((tag) => latestInstant(entriesFor(facts, taxonomy, tag, units))));
}

const USD = ["USD"];
const SHARES = ["shares"];

async function fetchFromEdgar(ticker: string): Promise<Omit<Fundamentals, "fetchedAt"> | null> {
  const entry = await tickerToCik(ticker);
  if (!entry) return null;
  const cik10 = String(entry.cik_str).padStart(10, "0");
  const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`, { headers });
  if (!res.ok) throw new Error(`EDGAR companyfacts fetch failed (${res.status}) for ${ticker}`);
  const data = await res.json();
  const facts: Facts = data?.facts ?? {};

  // US GAAP first pass
  let revenue = firstAnnual(
    facts,
    "us-gaap",
    ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"],
    USD,
  );
  let opIncome = firstAnnual(facts, "us-gaap", ["OperatingIncomeLoss"], USD);
  let netIncome = firstAnnual(facts, "us-gaap", ["NetIncomeLoss", "ProfitLoss"], USD);
  let cash = firstInstant(facts, "us-gaap", ["CashAndCashEquivalentsAtCarryingValue"], USD);

  // Total debt, best effort: long-term + short-term borrowings.
  let debt: number | null = null;
  {
    const lt =
      firstInstant(facts, "us-gaap", ["LongTermDebt"], USD) ??
      firstInstant(facts, "us-gaap", ["LongTermDebtNoncurrent"], USD);
    const st =
      firstInstant(facts, "us-gaap", ["ShortTermBorrowings"], USD) ??
      firstInstant(facts, "us-gaap", ["LongTermDebtCurrent"], USD);
    if (lt || st) debt = (lt?.val ?? 0) + (st?.val ?? 0);
  }

  // IFRS second pass for foreign filers (e.g. 20-F names like TSEM).
  if (!revenue) revenue = firstAnnual(facts, "ifrs-full", ["Revenue", "RevenueFromContractsWithCustomers"], USD);
  if (!opIncome) opIncome = firstAnnual(facts, "ifrs-full", ["ProfitLossFromOperatingActivities", "OperatingIncomeLoss"], USD);
  if (!netIncome) netIncome = firstAnnual(facts, "ifrs-full", ["ProfitLoss", "ProfitLossAttributableToOwnersOfParent"], USD);
  if (!cash) cash = firstInstant(facts, "ifrs-full", ["CashAndCashEquivalents"], USD);
  if (debt == null) {
    const ifrsDebt =
      firstInstant(facts, "ifrs-full", ["Borrowings"], USD) ??
      firstInstant(facts, "ifrs-full", ["NoncurrentPortionOfNoncurrentBorrowings"], USD);
    if (ifrsDebt) debt = ifrsDebt.val ?? null;
  }

  // Shares: dei cover-page count first, then balance-sheet counts.
  const shares =
    firstInstant(facts, "dei", ["EntityCommonStockSharesOutstanding"], SHARES) ??
    firstInstant(facts, "us-gaap", ["CommonStockSharesOutstanding", "CommonStockSharesIssued"], SHARES) ??
    firstInstant(facts, "ifrs-full", ["NumberOfSharesOutstanding"], SHARES);

  const fiscalPeriod = revenue?.end
    ? `FY${revenue.fy ?? new Date(revenue.end).getFullYear()} (ended ${revenue.end})`
    : null;

  return {
    ticker: ticker.toUpperCase(),
    revenue: revenue?.val ?? null,
    operatingIncome: opIncome?.val ?? null,
    netIncome: netIncome?.val ?? null,
    sharesOutstanding: shares?.val ?? null,
    cash: cash?.val ?? null,
    debt,
    fiscalPeriod,
  };
}

function rowToFundamentals(row: typeof tables.fundamentals.$inferSelect): Fundamentals {
  return {
    ticker: row.ticker,
    revenue: row.revenue,
    operatingIncome: row.operatingIncome,
    netIncome: row.netIncome,
    sharesOutstanding: row.sharesOutstanding,
    cash: row.cash,
    debt: row.debt,
    fiscalPeriod: row.fiscalPeriod,
    fetchedAt: row.fetchedAt ?? new Date(0),
  };
}

/** Latest fundamentals from EDGAR XBRL. Cached ~24h; stale cache on failure; null when nothing available. */
export async function getFundamentals(ticker: string): Promise<Fundamentals | null> {
  const t = ticker.toUpperCase();
  const cached = await db.query.fundamentals.findFirst({ where: eq(tables.fundamentals.ticker, t) });

  if (cached?.fetchedAt && Date.now() - cached.fetchedAt.getTime() < TTL_MS) {
    return rowToFundamentals(cached);
  }

  let fetched: Omit<Fundamentals, "fetchedAt"> | null = null;
  try {
    fetched = await fetchFromEdgar(t);
  } catch {
    fetched = null;
  }

  if (!fetched) return cached ? rowToFundamentals(cached) : null;

  const company = await db.query.companies.findFirst({ where: eq(tables.companies.ticker, t) });
  const now = new Date();
  const values = {
    ticker: t,
    companyId: company?.id ?? null,
    revenue: fetched.revenue,
    operatingIncome: fetched.operatingIncome,
    netIncome: fetched.netIncome,
    sharesOutstanding: fetched.sharesOutstanding,
    cash: fetched.cash,
    debt: fetched.debt,
    fiscalPeriod: fetched.fiscalPeriod,
    fetchedAt: now,
  };
  await db
    .insert(tables.fundamentals)
    .values(values)
    .onConflictDoUpdate({ target: tables.fundamentals.ticker, set: values });

  return { ...fetched, fetchedAt: now };
}
