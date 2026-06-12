import { NextRequest } from "next/server";
import { inArray } from "drizzle-orm";
import { db, tables } from "@/db";
import { computeDirective, latestDirective, humanizeDriver, type Directive } from "@/lib/oracle";

export const maxDuration = 300;

/** Strongest posterior mover, for the one-line flip explanation. */
function driverPhrase(d: Directive): string {
  const top = [...d.inputs.contributions].sort(
    (a, b) => Math.abs(b.deltaLogOdds) - Math.abs(a.deltaLogOdds),
  )[0];
  if (!top || Math.abs(top.deltaLogOdds) < 1e-9) return "inputs shifted";
  return `${humanizeDriver(top.name)} ${top.deltaLogOdds > 0 ? "strengthened" : "weakened the case"}`;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { ticker?: string; all?: boolean };

  try {
    // ---- refresh-all: every covered name, with flip alerts into The Perch ----
    if (body.all === true) {
      const companies = await db
        .select()
        .from(tables.companies)
        .where(inArray(tables.companies.status, ["active", "watchlist", "pipeline"]));

      const results: {
        ticker: string;
        action?: string;
        conviction?: number;
        pThesis?: number;
        changed?: boolean;
        error?: string;
      }[] = [];
      let alertsRaised = 0;

      // Sequential on purpose — one chain/news/EDGAR sweep at a time.
      for (const company of companies) {
        const t = company.ticker.toUpperCase();
        try {
          const previous = await latestDirective(t);
          const directive = await computeDirective(t);
          const changed = previous != null && previous.action !== directive.action;
          if (changed) {
            await db.insert(tables.alerts).values({
              companyId: company.id,
              ticker: t,
              severity: 2,
              kind: "directive",
              message: `Directive flipped ${previous!.action}→${directive.action} on ${t}: ${driverPhrase(directive)}, posterior ${previous!.pThesis.toFixed(2)}→${directive.pThesis.toFixed(2)}.`,
              suggestedAction: "Open the dossier and read the show-the-work before acting on the new directive.",
            });
            alertsRaised++;
          }
          results.push({
            ticker: t,
            action: directive.action,
            conviction: directive.conviction,
            pThesis: directive.pThesis,
            changed,
          });
        } catch (err) {
          results.push({ ticker: t, error: err instanceof Error ? err.message : "directive failed" });
        }
      }
      return Response.json({ refreshed: results.length, alertsRaised, results });
    }

    // ---- single name ----
    const ticker = body.ticker?.trim().toUpperCase();
    if (!ticker) return Response.json({ error: "Ticker required." }, { status: 400 });
    const directive = await computeDirective(ticker);
    return Response.json(directive);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "The Oracle could not rule." },
      { status: 500 },
    );
  }
}
