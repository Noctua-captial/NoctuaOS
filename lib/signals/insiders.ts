// EDGAR Form 4 insider activity — keyless, same submissions feed as lib/edgar.
// Recent form-4 filings (≤120 days, ≤10 XML fetches per refresh) are parsed
// for open-market purchases (code P) and sales (code S) with dollar values.
// Cluster-buy detector: ≥2 distinct insiders with P purchases inside any
// 14-day window — the one insider signal with real literature behind it.
import { tickerToCik } from "@/lib/edgar";
import { FETCH_TIMEOUT_MS, upsertSignal } from "@/lib/signals/common";

// Same UA convention as lib/edgar.ts — SEC requires a descriptive User-Agent.
const UA = process.env.EDGAR_USER_AGENT ?? "NoctuaOS research internal@noctua.local";
const headers = { "User-Agent": UA, "Accept-Encoding": "gzip" };

const WINDOW_DAYS = 120;
const MAX_FORM4_FETCHES = 10;
const CLUSTER_WINDOW_DAYS = 14;
const CLUSTER_MIN_INSIDERS = 2;
const SUBMISSIONS_TTL_MS = 6 * 60 * 60 * 1000;

export type InsiderTransaction = {
  insider: string;
  isDirector: boolean;
  isOfficer: boolean;
  officerTitle: string | null;
  code: "P" | "S"; // P = open-market purchase, S = sale
  shares: number | null;
  pricePerShare: number | null;
  value: number | null; // shares × price, $
  date: string; // transaction date (YYYY-MM-DD)
  filedAt: string;
  formUrl: string; // raw form4 XML
};

export type InsiderActivity = {
  ticker: string;
  asOf: string | null; // latest transaction date (or filing date when forms held no P/S); null with no form 4s
  transactions: InsiderTransaction[]; // P and S only, newest transaction first
  buyValue: number; // $ across P transactions
  sellValue: number; // $ across S transactions
  netValue: number; // buys − sells
  clusterBuy: boolean;
  distinctBuyers: number;
  filingsChecked: number;
  windowDays: number;
};

// --- caches (SEC politeness) --------------------------------------------------

type SubmissionsRecent = {
  form: string[];
  filingDate: string[];
  accessionNumber: string[];
  primaryDocument: string[];
};
const submissionsCache = new Map<string, { fetchedAt: number; recent: SubmissionsRecent; cik: number }>();
const form4Cache = new Map<string, InsiderTransaction[]>(); // accessionNumber → parsed transactions

// --- XML parsing (regex — form4 XML is flat and stable) -------------------------

function tagValue(xml: string, tag: string): string | null {
  // matches <tag>x</tag> and <tag><value>x</value></tag>
  const m = xml.match(new RegExp(`<${tag}>\\s*(?:<value>)?([^<]*)`, "i"));
  const v = m?.[1]?.trim();
  return v ? v : null;
}

function tagBool(xml: string, tag: string): boolean {
  const v = tagValue(xml, tag);
  return v === "1" || v?.toLowerCase() === "true";
}

function parseForm4(
  xml: string,
  filedAt: string,
  formUrl: string,
): InsiderTransaction[] {
  const ownerBlock = xml.match(/<reportingOwner>([\s\S]*?)<\/reportingOwner>/)?.[1] ?? xml;
  const insider = tagValue(ownerBlock, "rptOwnerName") ?? "Unknown insider";
  const isDirector = tagBool(ownerBlock, "isDirector");
  const isOfficer = tagBool(ownerBlock, "isOfficer");
  const officerTitle = tagValue(ownerBlock, "officerTitle");

  const out: InsiderTransaction[] = [];
  for (const m of xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)) {
    const block = m[1];
    const code = tagValue(block, "transactionCode");
    if (code !== "P" && code !== "S") continue; // only open-market buys/sells carry signal
    const date = tagValue(block, "transactionDate");
    if (!date) continue;
    const shares = Number(tagValue(block, "transactionShares"));
    const price = Number(tagValue(block, "transactionPricePerShare"));
    const sharesOk = Number.isFinite(shares) && shares > 0;
    const priceOk = Number.isFinite(price) && price > 0;
    out.push({
      insider,
      isDirector,
      isOfficer,
      officerTitle,
      code,
      shares: sharesOk ? shares : null,
      pricePerShare: priceOk ? price : null,
      value: sharesOk && priceOk ? shares * price : null,
      date: date.slice(0, 10),
      filedAt,
      formUrl,
    });
  }
  return out;
}

function detectClusterBuy(transactions: InsiderTransaction[]): boolean {
  const buys = transactions
    .filter((t) => t.code === "P")
    .map((t) => ({ insider: t.insider, time: Date.parse(`${t.date}T00:00:00Z`) }))
    .filter((b) => Number.isFinite(b.time))
    .sort((a, b) => a.time - b.time);
  for (let i = 0; i < buys.length; i++) {
    const windowEnd = buys[i].time + CLUSTER_WINDOW_DAYS * 86_400_000;
    const insiders = new Set<string>();
    for (let j = i; j < buys.length && buys[j].time <= windowEnd; j++) insiders.add(buys[j].insider);
    if (insiders.size >= CLUSTER_MIN_INSIDERS) return true;
  }
  return false;
}

/**
 * Recent Form 4 activity from the issuer's submissions feed: open-market
 * buys (P) vs sales (S) with dollar values over the last ~120 days, capped
 * at 10 XML fetches per refresh, with submissions and parsed forms cached
 * in memory. Persists one "insider" signals row (value = net insider $,
 * payload = transaction list + clusterBuy flag) when any form 4 exists.
 */
export async function fetchInsiderActivity(ticker: string): Promise<InsiderActivity> {
  const t = ticker.toUpperCase();

  let sub = submissionsCache.get(t);
  if (!sub || Date.now() - sub.fetchedAt > SUBMISSIONS_TTL_MS) {
    const entry = await tickerToCik(t);
    if (!entry) throw new Error(`Ticker ${t} not found in EDGAR registry.`);
    const cik10 = String(entry.cik_str).padStart(10, "0");
    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik10}.json`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`EDGAR submissions fetch failed (${res.status}) for ${t}`);
    const data = await res.json();
    const recent = data.filings?.recent as SubmissionsRecent | undefined;
    if (!recent) throw new Error(`EDGAR submissions feed empty for ${t}`);
    sub = { fetchedAt: Date.now(), recent, cik: entry.cik_str };
    submissionsCache.set(t, sub);
  }

  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { recent, cik } = sub;
  const picks: { accession: string; filedAt: string; primaryDoc: string }[] = [];
  for (let i = 0; i < recent.form.length && picks.length < MAX_FORM4_FETCHES; i++) {
    if (recent.form[i] !== "4") continue;
    const filedAt = recent.filingDate[i];
    if (filedAt < cutoff) break; // newest-first feed — everything below is older
    picks.push({
      accession: recent.accessionNumber[i],
      filedAt,
      primaryDoc: recent.primaryDocument[i],
    });
  }

  const transactions: InsiderTransaction[] = [];
  let latestFiledAt: string | null = null;
  for (const pick of picks) {
    latestFiledAt = latestFiledAt ?? pick.filedAt; // picks are newest first
    let parsed = form4Cache.get(pick.accession);
    if (!parsed) {
      // primaryDocument is the XSL-rendered path ("xslF345X06/doc.xml"); the raw XML
      // lives at the same accession with the xsl prefix stripped.
      const rawDoc = pick.primaryDoc.split("/").pop() ?? pick.primaryDoc;
      const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${pick.accession.replace(/-/g, "")}/${rawDoc}`;
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) continue; // skip unfetchable forms; the rest still count
        parsed = parseForm4(await res.text(), pick.filedAt, url);
        form4Cache.set(pick.accession, parsed);
      } catch {
        continue;
      }
    }
    transactions.push(...parsed);
  }
  transactions.sort((a, b) => b.date.localeCompare(a.date));

  let buyValue = 0;
  let sellValue = 0;
  for (const tx of transactions) {
    if (tx.value == null) continue;
    if (tx.code === "P") buyValue += tx.value;
    else sellValue += tx.value;
  }
  const clusterBuy = detectClusterBuy(transactions);
  const distinctBuyers = new Set(transactions.filter((tx) => tx.code === "P").map((tx) => tx.insider))
    .size;

  const asOf = transactions[0]?.date ?? latestFiledAt;
  const activity: InsiderActivity = {
    ticker: t,
    asOf,
    transactions,
    buyValue,
    sellValue,
    netValue: buyValue - sellValue,
    clusterBuy,
    distinctBuyers,
    filingsChecked: picks.length,
    windowDays: WINDOW_DAYS,
  };

  if (asOf != null) {
    await upsertSignal({
      ticker: t,
      kind: "insider",
      value: activity.netValue,
      z: null,
      asOf,
      payload: activity,
    });
  }

  return activity;
}
