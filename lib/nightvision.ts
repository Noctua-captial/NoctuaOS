// Night Vision — automatic monitoring sweep across all covered names.
// Keyless paths (EDGAR new-filing detection, price moves, catalyst timing,
// thesis staleness) always run. The LLM relevance pass activates only when a
// provider key is configured; on any model failure it degrades silently to
// the plain filing alert that has already been raised.
import fs from "fs";
import path from "path";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { generateObject } from "ai";
import { z } from "zod";
import { db, tables } from "@/db";
import { recentFilings, fetchFilingText, type EdgarFiling } from "@/lib/edgar";
import { storeDocument, searchVault } from "@/lib/vault";
import { getQuotes } from "@/lib/market";
import { refreshSignals } from "@/lib/signals";
import { modelFor } from "@/lib/models";
import { CONSTITUTION } from "@/lib/athena";

// Market-signal alert thresholds (kept high — the queue is for attention, not noise).
const SIGNAL_UNUSUAL_VOLUME_Z = 2.5;
const SIGNAL_SHORT_Z = 2.5;
const SIGNAL_NEWS_BURST_ITEMS = 6; // items inside 48h

// ---------- throttle state (gitignored file, not the repo DB) ----------
const STATE_FILE = path.join(process.cwd(), ".nightvision.json");

export const SCAN_INTERVAL_MS = 10 * 60 * 1000;

/** Timestamp of the last scan, or null if Night Vision has never run. */
export function lastScan(): Date | null {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { lastScanAt?: string };
    if (!raw.lastScanAt) return null;
    const d = new Date(raw.lastScanAt);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function recordScan(): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastScanAt: new Date().toISOString() }) + "\n");
}

// ---------- events ----------
export type ScanEvent = {
  stage:
    | "start"
    | "model"
    | "quotes"
    | "company"
    | "filing"
    | "signal"
    | "alert"
    | "skip"
    | "error"
    | "done";
  message: string;
  ticker?: string;
  alertsRaised?: number;
  documentsIngested?: number;
};

type Emit = (e: ScanEvent) => void;

// ---------- alert raising with dedupe ----------
// Never create a duplicate unresolved alert with the same companyId + kind +
// message prefix. The prefix defaults to the leading 64 chars of the message;
// call sites with volatile message bodies (e.g. day-change %) pass a stable one.
async function raiseAlert(opts: {
  companyId: number;
  ticker: string;
  severity: number;
  kind: string;
  message: string;
  suggestedAction: string;
  dedupePrefix?: string;
}): Promise<boolean> {
  const prefix = (opts.dedupePrefix ?? opts.message).slice(0, 64);
  const existing = await db
    .select({ message: tables.alerts.message })
    .from(tables.alerts)
    .where(
      and(
        eq(tables.alerts.companyId, opts.companyId),
        eq(tables.alerts.kind, opts.kind),
        eq(tables.alerts.resolved, false),
      ),
    );
  if (existing.some((a) => a.message.startsWith(prefix))) return false;

  await db.insert(tables.alerts)
    .values({
      companyId: opts.companyId,
      ticker: opts.ticker,
      severity: opts.severity,
      kind: opts.kind,
      message: opts.message,
      suggestedAction: opts.suggestedAction,
    });
  return true;
}

// ---------- LLM relevance pass ----------
const signalSchema = z.object({
  signal: z
    .string()
    .describe("One-sentence observation from the new filing. Cold, institutional, specific."),
  relevance: z
    .string()
    .describe(
      "Which thesis point or kill criterion this bears on, e.g. 'Supports thesis point #2' or 'Pressures kill criterion #1'",
    ),
  confidence: z.enum(["low", "medium", "high"]),
  suggestedAction: z.string().describe("The single next action for the covering analyst"),
});

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type CompanyRow = typeof tables.companies.$inferSelect;
type ThesisRow = typeof tables.theses.$inferSelect;

async function latestThesis(companyId: number): Promise<ThesisRow | null> {
  const rows = await db
    .select()
    .from(tables.theses)
    .where(eq(tables.theses.companyId, companyId))
    .orderBy(desc(tables.theses.version))
    .limit(1);
  return rows[0] ?? null;
}

/** Read the new filing against the current thesis and raise a branded signal alert. */
async function nightVisionSignal(
  model: ReturnType<typeof modelFor>,
  company: CompanyRow,
  filing: EdgarFiling,
  documentId: number,
): Promise<boolean> {
  const thesis = await latestThesis(company.id);
  const thesisText = thesis
    ? [
        `Thesis v${thesis.version}: ${thesis.oneLiner}`,
        thesis.variantPerception ? `Variant perception: ${thesis.variantPerception}` : null,
        thesis.whatMustHappen ? `What must happen: ${thesis.whatMustHappen}` : null,
        thesis.killCriteria ? `Kill criteria: ${thesis.killCriteria}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : `No formal thesis on file. Business summary: ${company.businessSummary ?? "n/a"}`;

  // Top chunks from the freshly ingested filing, retrieved against the thesis.
  const hits = await searchVault(thesis?.oneLiner ?? company.businessSummary ?? company.name, {
    ticker: company.ticker,
    limit: 12,
  });
  const fromNewDoc = hits.filter((h) => h.documentId === documentId);
  const excerpts = (fromNewDoc.length > 0 ? fromNewDoc : hits)
    .slice(0, 5)
    .map((h) => h.text.slice(0, 1500))
    .join("\n\n---\n\n");

  const { object } = await generateObject({
    model: model.model,
    schema: signalSchema,
    system: CONSTITUTION,
    prompt: `You are Night Vision, Noctua's overnight monitoring agent. A new ${filing.formType} for ${company.ticker} (${company.name}), filed ${filing.filedAt}, was just ingested to the Vault.

CURRENT THESIS:
${thesisText}

EXCERPTS FROM THE NEW FILING:
${excerpts || "(no excerpts retrieved — judge from the filing type and date alone, at low confidence)"}

Assess what, if anything, in this filing bears on the thesis. One signal only — the most decision-relevant observation. If the filing is routine, say so plainly and mark confidence low.`,
  });

  const relevance = object.relevance.replace(/\.+$/, "");
  return raiseAlert({
    companyId: company.id,
    ticker: company.ticker,
    severity: 2,
    kind: "signal",
    message: `NIGHT VISION — ${object.signal.replace(/\.+$/, "")}. ${relevance}. Confidence: ${cap(object.confidence)}.`,
    suggestedAction: object.suggestedAction,
    dedupePrefix: `NIGHT VISION — ${object.signal.slice(0, 40)}`,
  });
}

// ---------- keyless signal helpers ----------
function daysUntil(expectedDate: string | null): number | null {
  if (!expectedDate) return null;
  // Only firm ISO-style dates qualify; fuzzy windows like "Q3 2026" are skipped.
  if (!/^\d{4}-\d{2}-\d{2}/.test(expectedDate.trim())) return null;
  const t = new Date(expectedDate.trim().slice(0, 10) + "T00:00:00Z").getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

// ---------- the scan ----------
export async function runNightVisionScan(
  emit: Emit,
): Promise<{ alertsRaised: number; documentsIngested: number }> {
  recordScan();

  const companies = await db
    .select()
    .from(tables.companies)
    .where(inArray(tables.companies.status, ["active", "watchlist", "pipeline", "rejected"]));

  emit({ stage: "start", message: `Night Vision sweep: ${companies.length} covered names.` });

  // One model resolution per scan. No key → keyless signals only.
  let nv: ReturnType<typeof modelFor> | null = null;
  try {
    nv = modelFor("nightvision");
  } catch {
    nv = null;
  }
  emit({
    stage: "model",
    message: nv
      ? `Relevance agent online (${nv.modelId}).`
      : "No provider key — running keyless signals only.",
  });

  let alertsRaised = 0;
  let documentsIngested = 0;
  const raised = async (ok: boolean, msg: string, ticker: string) => {
    if (ok) {
      alertsRaised++;
      emit({ stage: "alert", ticker, message: msg });
    }
  };

  // Batched quotes for the price-move signal.
  emit({ stage: "quotes", message: "Pulling live quotes for the coverage list…" });
  const quotes = await getQuotes(companies.map((c) => c.ticker));

  for (const company of companies) {
    const t = company.ticker;
    emit({ stage: "company", ticker: t, message: `Sweeping ${t} (${company.status})…` });

    // ---- 1) EDGAR: filings newer than the newest Vault document ----
    try {
      const filings = await recentFilings(t);
      const newestDoc = await db
        .select({ filedAt: tables.documents.filedAt })
        .from(tables.documents)
        .where(and(eq(tables.documents.ticker, t), isNotNull(tables.documents.filedAt)))
        .orderBy(desc(tables.documents.filedAt))
        .limit(1);
      const watermark = newestDoc[0]?.filedAt ?? null;

      let fresh = filings
        .filter((f) => !watermark || f.filedAt > watermark)
        .sort((a, b) => b.filedAt.localeCompare(a.filedAt));

      // Drop anything already stored (same source URL), regardless of dates.
      const checked: EdgarFiling[] = [];
      for (const f of fresh) {
        const dup = await db.query.documents.findFirst({
          where: eq(tables.documents.source, f.url),
        });
        if (!dup) checked.push(f);
      }
      fresh = checked;

      // SEC politeness: at most one filing-text fetch per company per scan.
      const deferred = fresh.length - 1;
      for (const f of fresh.slice(0, 1)) {
        emit({ stage: "filing", ticker: t, message: `New ${f.formType} filed ${f.filedAt} — ingesting…` });
        const text = await fetchFilingText(f.url);
        const { documentId, chunkCount } = await storeDocument({
          companyId: company.id,
          ticker: t,
          title: `${f.companyName} — ${f.formType} (${f.filedAt})`,
          docType: "filing",
          formType: f.formType,
          source: f.url,
          filedAt: f.filedAt,
          content: text,
        });
        documentsIngested++;

        await raised(
          await raiseAlert({
            companyId: company.id,
            ticker: t,
            severity: 2,
            kind: "filing",
            message: `New ${f.formType} filed ${f.filedAt} — auto-ingested to the Vault (${chunkCount} chunks).`,
            suggestedAction: "Review the filing against the current thesis and kill criteria.",
          }),
          `Filing alert raised for ${t} (${f.formType}).`,
          t,
        );

        // Rejected names: a new filing reopens the question.
        if (company.status === "rejected" && company.rejectionReason) {
          await raised(
            await raiseAlert({
              companyId: company.id,
              ticker: t,
              severity: 3,
              kind: "stale_thesis",
              message: `Previously rejected name filed a new ${f.formType} (${f.filedAt}). Recorded rejection: ${company.rejectionReason.slice(0, 200)} Reopen review?`,
              suggestedAction: "Assign Dossier Agent to re-screen against the original rejection reason.",
              dedupePrefix: "Previously rejected name filed",
            }),
            `Reopen-review alert raised for ${t}.`,
            t,
          );
        }

        // LLM relevance pass — silent fallback to the plain filing alert above.
        if (nv) {
          try {
            await raised(
              await nightVisionSignal(nv, company, f, documentId),
              `NIGHT VISION signal raised for ${t}.`,
              t,
            );
          } catch {
            emit({
              stage: "skip",
              ticker: t,
              message: `Relevance agent unavailable for ${t} — plain filing alert stands.`,
            });
          }
        }
      }
      if (deferred > 0) {
        emit({
          stage: "skip",
          ticker: t,
          message: `${deferred} more new filing${deferred === 1 ? "" : "s"} for ${t} deferred to the next scan.`,
        });
      }
    } catch (err) {
      emit({
        stage: "error",
        ticker: t,
        message: `EDGAR check failed for ${t}: ${err instanceof Error ? err.message : "unknown error"}`,
      });
    }

    // ---- 2) Price move >= 8% ----
    const q = quotes.get(t);
    if (q?.dayChangePct != null && Math.abs(q.dayChangePct) >= 8) {
      await raised(
        await raiseAlert({
          companyId: company.id,
          ticker: t,
          severity: 3,
          kind: "noise_drop",
          message: `Moved ${q.dayChangePct.toFixed(1)}% today — company-specific news or noise? Check against thesis.`,
          suggestedAction: "Verify the move against the thesis and kill criteria before reacting.",
          dedupePrefix: "Moved ",
        }),
        `Price-move alert raised for ${t} (${q.dayChangePct.toFixed(1)}%).`,
        t,
      );
    }

    // ---- 3) Catalysts inside the 7-day window ----
    const cats = await db
      .select()
      .from(tables.catalysts)
      .where(eq(tables.catalysts.companyId, company.id));
    for (const c of cats) {
      const d = daysUntil(c.expectedDate);
      if (d == null || d < 0 || d > 7) continue;
      await raised(
        await raiseAlert({
          companyId: company.id,
          ticker: t,
          severity: 2,
          kind: "catalyst",
          message: `Catalyst approaching: ${c.title} — expected ${c.expectedDate} (${d === 0 ? "today" : `T-${d}`}).`,
          suggestedAction:
            "Pre-register expectations: write down what the thesis predicts before the event.",
          dedupePrefix: `Catalyst approaching: ${c.title}`.slice(0, 64),
        }),
        `Catalyst alert raised for ${t} (${c.title}).`,
        t,
      );
    }

    // ---- 4) Market signals: one refresh per name per scan, alerts on
    // threshold crossings only. Rejected names are watched for filings, not
    // tape — their signal refresh is skipped out of politeness to the sources.
    if (company.status !== "rejected") {
      try {
        emit({ stage: "signal", ticker: t, message: `Refreshing market signals for ${t}…` });
        const snap = await refreshSignals(t, company.name);

        const uvz = snap.options?.unusualVolumeZ;
        if (uvz != null && uvz >= SIGNAL_UNUSUAL_VOLUME_Z) {
          await raised(
            await raiseAlert({
              companyId: company.id,
              ticker: t,
              severity: 3,
              kind: "signal",
              message: `Options volume is running ${uvz.toFixed(1)} standard deviations above its history (${snap.options!.totalVolume.toLocaleString()} contracts today, as of ${snap.options!.asOf.slice(0, 10)}). Positioning is arriving.`,
              suggestedAction: "Check the chain for where the volume sits — strikes and expiries tell the story.",
              dedupePrefix: "Options volume is running",
            }),
            `Unusual options volume alert raised for ${t}.`,
            t,
          );
        }

        if (snap.insider?.clusterBuy) {
          await raised(
            await raiseAlert({
              companyId: company.id,
              ticker: t,
              severity: 2,
              kind: "insider",
              message: `Insider cluster buy: ${snap.insider.distinctBuyers} distinct insiders bought ~$${Math.round(snap.insider.buyValue / 1000).toLocaleString()}K inside 14 days (as of ${snap.insider.asOf}). Clustered buying is the one insider signal with literature behind it.`,
              suggestedAction: "Read the Form 4s — who bought, at what price, and against what news.",
              dedupePrefix: "Insider cluster buy:",
            }),
            `Insider cluster-buy alert raised for ${t}.`,
            t,
          );
        }

        const shortZ = snap.short?.z;
        if (shortZ != null && shortZ >= SIGNAL_SHORT_Z) {
          await raised(
            await raiseAlert({
              companyId: company.id,
              ticker: t,
              severity: 3,
              kind: "signal",
              message: `Short-sale pressure z ${shortZ.toFixed(1)} vs its 60-day norm (${(snap.short!.ratio * 100).toFixed(0)}% of volume sold short, as of ${snap.short!.asOf}). Someone is leaning on the name.`,
              suggestedAction: "Check the borrow and any fresh bear publications before reacting.",
              dedupePrefix: "Short-sale pressure z",
            }),
            `Short-pressure alert raised for ${t}.`,
            t,
          );
        }

        if (snap.news && snap.news.burstCount >= SIGNAL_NEWS_BURST_ITEMS) {
          await raised(
            await raiseAlert({
              companyId: company.id,
              ticker: t,
              severity: 3,
              kind: "signal",
              message: `News burst: ${snap.news.burstCount} headlines inside 48 hours. The narrative is moving faster than the filings.`,
              suggestedAction: "Scan the headline list for the one item that actually bears on the thesis.",
              dedupePrefix: "News burst:",
            }),
            `News-burst alert raised for ${t}.`,
            t,
          );
        }
      } catch (err) {
        emit({
          stage: "error",
          ticker: t,
          message: `Signal refresh failed for ${t}: ${err instanceof Error ? err.message : "unknown error"}`,
        });
      }
    }

    // ---- 5) Stale thesis: no dossier update in 60 days ----
    // Rejected names are covered by the reopen watch above, not staleness.
    if (company.status !== "rejected" && company.updatedAt) {
      const ageDays = Math.floor((Date.now() - company.updatedAt.getTime()) / 86_400_000);
      if (ageDays > 60) {
        await raised(
          await raiseAlert({
            companyId: company.id,
            ticker: t,
            severity: 4,
            kind: "stale_thesis",
            message: `Thesis not updated in ${ageDays} days. Evidence decays; conviction should not outlive its inputs.`,
            suggestedAction: "Refresh the dossier or formally archive the name.",
            dedupePrefix: "Thesis not updated in",
          }),
          `Stale-thesis alert raised for ${t} (${ageDays}d).`,
          t,
        );
      }
    }
  }

  emit({
    stage: "done",
    message: `Sweep complete: ${alertsRaised} alert${alertsRaised === 1 ? "" : "s"} raised, ${documentsIngested} document${documentsIngested === 1 ? "" : "s"} ingested.`,
    alertsRaised,
    documentsIngested,
  });
  return { alertsRaised, documentsIngested };
}
