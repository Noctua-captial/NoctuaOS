// SEC EDGAR ingestion — free, no API key. SEC's fair-access policy REQUIRES a
// descriptive User-Agent with contact info and ≤10 req/s; set EDGAR_USER_AGENT
// (see .env.example). All requests go through fetchSec, which enforces the
// shared SEC rate limit, a timeout, and retries.
import { fetchSec } from "@/lib/net";

const UA = process.env.EDGAR_USER_AGENT ?? "NoctuaOS/0.1 (contact: set EDGAR_USER_AGENT)";
if (!process.env.EDGAR_USER_AGENT) {
  console.warn(
    "[edgar] EDGAR_USER_AGENT is not set — using a placeholder UA. SEC may rate-limit or block requests; set it in .env.local.",
  );
}

const headers = { "User-Agent": UA, "Accept-Encoding": "gzip" };

type TickerEntry = { cik_str: number; ticker: string; title: string };

let tickerMapCache: Record<string, TickerEntry> | null = null;

export async function tickerToCik(ticker: string): Promise<TickerEntry | null> {
  if (!tickerMapCache) {
    const res = await fetchSec("https://www.sec.gov/files/company_tickers.json", headers);
    if (!res.ok) throw new Error(`EDGAR ticker map fetch failed (${res.status})`);
    const raw = (await res.json()) as Record<string, TickerEntry>;
    tickerMapCache = {};
    for (const v of Object.values(raw)) tickerMapCache[v.ticker.toUpperCase()] = v;
  }
  return tickerMapCache[ticker.toUpperCase()] ?? null;
}

export type EdgarFiling = {
  formType: string;
  filedAt: string;
  accessionNumber: string;
  primaryDocument: string;
  url: string;
  companyName: string;
};

export async function recentFilings(
  ticker: string,
  // includes foreign-private-issuer forms (20-F/6-K) for names like TSEM
  forms: string[] = ["10-K", "10-Q", "8-K", "20-F", "6-K", "40-F"],
  limit = 5,
): Promise<EdgarFiling[]> {
  const entry = await tickerToCik(ticker);
  if (!entry) throw new Error(`Ticker ${ticker} not found in EDGAR registry.`);

  const cik10 = String(entry.cik_str).padStart(10, "0");
  const res = await fetchSec(`https://data.sec.gov/submissions/CIK${cik10}.json`, headers);
  if (!res.ok) throw new Error(`EDGAR submissions fetch failed (${res.status})`);
  const data = await res.json();

  const recent = data.filings?.recent;
  if (!recent) return [];

  const out: EdgarFiling[] = [];
  const seenForms = new Map<string, number>();

  for (let i = 0; i < recent.form.length && out.length < limit; i++) {
    const form = recent.form[i] as string;
    if (!forms.includes(form)) continue;
    // take at most 2 of each form type, newest first (EDGAR lists newest first)
    const count = seenForms.get(form) ?? 0;
    if (count >= 2) continue;
    seenForms.set(form, count + 1);

    const accession = (recent.accessionNumber[i] as string).replace(/-/g, "");
    const primaryDoc = recent.primaryDocument[i] as string;
    out.push({
      formType: form,
      filedAt: recent.filingDate[i] as string,
      accessionNumber: recent.accessionNumber[i] as string,
      primaryDocument: primaryDoc,
      url: `https://www.sec.gov/Archives/edgar/data/${entry.cik_str}/${accession}/${primaryDoc}`,
      companyName: data.name ?? entry.title,
    });
  }
  return out;
}

/** Fetch a filing's primary document and strip it to readable text. */
export async function fetchFilingText(url: string, maxChars = 600_000): Promise<string> {
  const res = await fetchSec(url, headers);
  if (!res.ok) throw new Error(`Filing fetch failed (${res.status}) for ${url}`);
  const html = await res.text();
  return htmlToText(html).slice(0, maxChars);
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(ix:header|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;|&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
