// Night Vision for the options book. Sweeps every open structure and raises
// attention-queue alerts for the things that bite a derivatives desk and never
// show up in an equity P&L: time decay near expiry, IV crush into earnings on
// long vega, short strikes going in-the-money (assignment), breakeven breaches,
// and a net-short-vega book in a stressed regime. Keyless, deduped, and cheap —
// it leans on computeOptionsBook (already marked to model) for the hard part.
import { and, eq, inArray } from "drizzle-orm";
import { db, tables } from "@/db";
import { computeOptionsBook } from "@/lib/options/book";
import { computeRegime } from "@/lib/warroom";
import { OPTIONS_MANDATE } from "@/lib/quant";

const MANAGE_DTE = 21; // roll / take-down window — the classic "manage at 21 DTE"
const TAKE_PROFIT_FRAC = 0.5; // 50% of max profit captured → take it down
const BREAKEVEN_NEAR_PCT = 3; // underlying within 3% of a breakeven, underwater
const EARNINGS_WINDOW_DAYS = 10; // long-vega + earnings inside this → IV-crush warning

export type OptionsMonitorEvent = {
  stage: "start" | "structure" | "alert" | "done" | "error";
  message: string;
  ticker?: string;
};

type Emit = (e: OptionsMonitorEvent) => void;

/** Dedupe-raise: never stack the same unresolved (companyId|ticker)+kind+prefix alert. */
async function raiseAlert(opts: {
  companyId: number | null;
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
    .where(and(eq(tables.alerts.kind, opts.kind), eq(tables.alerts.resolved, false)));
  if (existing.some((a) => a.message.startsWith(prefix))) return false;
  await db.insert(tables.alerts).values({
    companyId: opts.companyId,
    ticker: opts.ticker,
    severity: opts.severity,
    kind: opts.kind,
    message: opts.message,
    suggestedAction: opts.suggestedAction,
  });
  return true;
}

/** Sweep the open options book and raise structure-level alerts. Returns the count raised. */
export async function runOptionsMonitor(emit?: Emit): Promise<{ alertsRaised: number }> {
  const fire = emit ?? (() => {});
  const book = await computeOptionsBook();
  fire({ stage: "start", message: `Options sweep: ${book.open.length} open structure${book.open.length === 1 ? "" : "s"}.` });

  let alertsRaised = 0;
  const raised = async (ok: boolean, msg: string, ticker: string) => {
    if (ok) {
      alertsRaised++;
      fire({ stage: "alert", ticker, message: msg });
    }
  };

  // Earnings/catalyst dates per covered company, for the IV-crush check.
  const companyIds = [...new Set(book.open.map((s) => s.companyId).filter((x): x is number => x != null))];
  const catalystRows =
    companyIds.length > 0
      ? await db.select().from(tables.catalysts).where(inArray(tables.catalysts.companyId, companyIds))
      : [];
  const catalystsByCompany = new Map<number, { title: string; date: string }[]>();
  for (const c of catalystRows) {
    if (!c.companyId || !c.expectedDate || !/^\d{4}-\d{2}-\d{2}/.test(c.expectedDate.trim())) continue;
    const list = catalystsByCompany.get(c.companyId) ?? [];
    list.push({ title: c.title, date: c.expectedDate.trim().slice(0, 10) });
    catalystsByCompany.set(c.companyId, list);
  }
  const daysUntil = (iso: string) => Math.ceil((Date.parse(`${iso}T00:00:00Z`) - Date.now()) / 86_400_000);

  for (const s of book.open) {
    fire({ stage: "structure", ticker: s.ticker, message: `Checking ${s.qty}× ${s.strategy} on ${s.ticker}…` });
    const id = `#${s.id}`;

    // 1) DTE / roll window.
    if (s.dte != null && s.dte <= MANAGE_DTE && s.dte >= 0) {
      await raised(
        await raiseAlert({
          companyId: s.companyId,
          ticker: s.ticker,
          severity: s.dte <= 7 ? 2 : 3,
          kind: "signal",
          message: `OPTIONS — ${s.ticker} ${s.strategy.replace(/_/g, " ")} ${id} is ${s.dte}d to expiry. Manage: roll, close, or let it run into pin/assignment risk.`,
          suggestedAction: "Roll out, take the structure down, or document why it runs to expiry.",
          dedupePrefix: `OPTIONS — ${s.ticker} ${s.strategy} ${id} is`,
        }),
        `DTE/roll alert for ${s.ticker} ${id}.`,
        s.ticker,
      );
    }

    // 2) Take-profit: ≥ 50% of max profit captured.
    if (s.pnlUsd != null && s.pnlUsd > 0 && s.maxGain != null && s.maxGain > 0) {
      const maxProfitTotal = s.maxGain * s.qty;
      if (s.pnlUsd >= TAKE_PROFIT_FRAC * maxProfitTotal) {
        await raised(
          await raiseAlert({
            companyId: s.companyId,
            ticker: s.ticker,
            severity: 3,
            kind: "signal",
            message: `OPTIONS — ${s.ticker} ${s.strategy.replace(/_/g, " ")} ${id} has captured ${Math.round((s.pnlUsd / maxProfitTotal) * 100)}% of max profit (+$${s.pnlUsd.toLocaleString()}). The last dollars carry the worst risk-reward.`,
            suggestedAction: "Take it down or roll to a fresh structure — do not grind the residual theta against tail risk.",
            dedupePrefix: `OPTIONS — ${s.ticker} ${s.strategy} ${id} has captured`,
          }),
          `Take-profit alert for ${s.ticker} ${id}.`,
          s.ticker,
        );
      }
    }

    // 3) Short-strike assignment risk: a short leg is in-the-money.
    if (s.currentUnderlying != null) {
      const u = s.currentUnderlying;
      const itmShort = s.legs.find(
        (l) => l.action === "short" && ((l.right === "C" && u > l.strike) || (l.right === "P" && u < l.strike)),
      );
      if (itmShort) {
        await raised(
          await raiseAlert({
            companyId: s.companyId,
            ticker: s.ticker,
            severity: s.dte != null && s.dte <= MANAGE_DTE ? 2 : 3,
            kind: "signal",
            message: `OPTIONS — ${s.ticker} short ${itmShort.right}${itmShort.strike} ${id} is in the money (underlying $${u.toFixed(2)}). Early-assignment and pin risk are live${s.dte != null ? ` at ${s.dte}d` : ""}.`,
            suggestedAction: "Decide to roll, close, or accept assignment before it is decided for you — especially around ex-div.",
            dedupePrefix: `OPTIONS — ${s.ticker} short ${itmShort.right}${itmShort.strike} ${id} is in the money`,
          }),
          `Assignment-risk alert for ${s.ticker} ${id}.`,
          s.ticker,
        );
      }
    }

    // 4) Breakeven breach: near a breakeven and underwater.
    if (s.breakevenDistancePct != null && s.breakevenDistancePct <= BREAKEVEN_NEAR_PCT && (s.pnlUsd ?? 0) < 0) {
      await raised(
        await raiseAlert({
          companyId: s.companyId,
          ticker: s.ticker,
          severity: 3,
          kind: "signal",
          message: `OPTIONS — ${s.ticker} ${s.strategy.replace(/_/g, " ")} ${id} sits ${s.breakevenDistancePct.toFixed(1)}% from breakeven and underwater. The thesis window is closing on this expiry.`,
          suggestedAction: "Re-test the directional thesis; roll for time or cut if the move has not come.",
          dedupePrefix: `OPTIONS — ${s.ticker} ${s.strategy} ${id} sits`,
        }),
        `Breakeven-breach alert for ${s.ticker} ${id}.`,
        s.ticker,
      );
    }

    // 5) IV-crush warning: long vega into a dated catalyst.
    if (s.greeksPerLot && s.greeksPerLot.vega > 0 && s.companyId != null) {
      const cats = catalystsByCompany.get(s.companyId) ?? [];
      const near = cats.find((c) => {
        const d = daysUntil(c.date);
        return d >= 0 && d <= EARNINGS_WINDOW_DAYS;
      });
      if (near) {
        await raised(
          await raiseAlert({
            companyId: s.companyId,
            ticker: s.ticker,
            severity: 3,
            kind: "catalyst",
            message: `OPTIONS — ${s.ticker} ${s.strategy.replace(/_/g, " ")} ${id} is long vega ($${s.greeksPerLot.vega}/pt) into "${near.title}" (${near.date}). Post-event IV crush will bleed the position even if direction is right.`,
            suggestedAction: "Decide before the event: hold for the move, or convert to a debit spread to neutralize vega.",
            dedupePrefix: `OPTIONS — ${s.ticker} ${s.strategy} ${id} is long vega`,
          }),
          `IV-crush alert for ${s.ticker} ${id}.`,
          s.ticker,
        );
      }
    }
  }

  // 6) Book-level: net-short vega in a stressed regime is the classic blow-up.
  const regime = await computeRegime().catch(() => null);
  const stressed = (regime?.pStressed != null && regime.pStressed >= 0.6) || regime?.volRegime === "stressed";
  const vegaPct = book.navUsd > 0 ? (Math.abs(book.greeks.vegaUsd) / book.navUsd) * 100 : 0;
  if (stressed && book.greeks.vegaUsd < 0 && vegaPct > 0.5 * OPTIONS_MANDATE.maxBookVegaPctPerVolPt) {
    await raised(
      await raiseAlert({
        companyId: null,
        ticker: "BOOK",
        severity: 2,
        kind: "signal",
        message: `OPTIONS — the book is net SHORT vega ($${book.greeks.vegaUsd.toLocaleString()}/pt) into a stressed regime. A vol spike is a direct hit with no price move required.`,
        suggestedAction: "Buy back vega or add long-vega hedges until the regime clears.",
        dedupePrefix: "OPTIONS — the book is net SHORT vega",
      }),
      "Net-short-vega/stressed-regime alert.",
      "BOOK",
    );
  }

  fire({ stage: "done", message: `Options sweep complete: ${alertsRaised} alert${alertsRaised === 1 ? "" : "s"} raised.` });
  return { alertsRaised };
}
