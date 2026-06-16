// Options sizing — defined-risk, budget-bound. The equity sizer sizes shares by
// % of NAV; an options structure is sized by how much PREMIUM (max loss) the
// edge justifies, capped by per-trade and book premium budgets and a portfolio
// vega budget. Kelly runs on the structure's OWN payoff (POP + payoff ratio),
// not on a linear stock return. Deterministic; the binding constraint is named.
import { OPTIONS_MANDATE, type OptionsMandate } from "@/lib/quant";

export type OptionSizingInput = {
  maxLoss: number; // $/lot, positive
  maxGain: number | null; // $/lot, null = unbounded
  pop: number | null; // probability of profit, 0..1
  evRealPerLot: number | null; // posterior-drifted MC EV, $/lot
  vegaPerLot: number | null; // $/lot per vol point (signed)
  navUsd: number;
  bookPremiumAtRiskUsd?: number; // current aggregate worst-case $ already committed
  bookVegaUsd?: number; // current signed book vega $
  mandate?: OptionsMandate;
};

export type OptionSizingConstraint =
  | "kelly"
  | "premium_per_trade"
  | "premium_book"
  | "vega_budget"
  | "no_edge";

export type OptionSizingOutput = {
  qty: number; // integer structure-lots to put on
  capitalAtRiskUsd: number; // qty × maxLoss
  capitalAtRiskPct: number; // % of NAV
  kellyFraction: number; // half-Kelly fraction of NAV the edge justifies (0..1)
  kellyLots: number; // lots the half-Kelly capital allows
  perTradeCapLots: number;
  bookCapLots: number;
  vegaCapLots: number | null; // null = vega budget not binding (no per-lot vega)
  bindingConstraint: OptionSizingConstraint;
};

/**
 * Half-Kelly fraction of NAV for a defined-risk bet.
 *   - Bounded gain: f* = (p·b − q)/b with b = maxGain/maxLoss, p = POP — the
 *     classic Kelly for a binary-ish payoff; we take half.
 *   - Unbounded gain (long calls/puts): no finite b, so use the edge ratio
 *     EV/maxLoss as the fractional proxy, halved.
 * Returns 0 when the edge is non-positive.
 */
function halfKellyFraction(input: OptionSizingInput): number {
  const { maxLoss, maxGain, pop, evRealPerLot } = input;
  if (!(maxLoss > 0)) return 0;
  if (maxGain != null && pop != null) {
    const b = maxGain / maxLoss;
    if (!(b > 0)) return 0;
    const f = (pop * b - (1 - pop)) / b;
    return f > 0 ? f / 2 : 0;
  }
  // Unbounded gain: lean on the real-world EV per dollar at risk.
  if (evRealPerLot != null && evRealPerLot > 0) {
    return Math.min(evRealPerLot / maxLoss, 1) / 2;
  }
  return 0;
}

const floorNonNeg = (v: number) => Math.max(0, Math.floor(v + 1e-9));

export function optionSizing(input: OptionSizingInput): OptionSizingOutput {
  const mandate = input.mandate ?? OPTIONS_MANDATE;
  const nav = input.navUsd > 0 ? input.navUsd : 0;
  const maxLoss = input.maxLoss;

  const empty = (binding: OptionSizingConstraint, kellyFraction = 0): OptionSizingOutput => ({
    qty: 0,
    capitalAtRiskUsd: 0,
    capitalAtRiskPct: 0,
    kellyFraction,
    kellyLots: 0,
    perTradeCapLots: 0,
    bookCapLots: 0,
    vegaCapLots: null,
    bindingConstraint: binding,
  });

  if (!(maxLoss > 0) || nav <= 0) return empty("no_edge");

  const kellyFraction = halfKellyFraction(input);
  if (kellyFraction <= 0) return empty("no_edge", kellyFraction);

  // Lots permitted by each budget.
  const kellyLots = floorNonNeg((kellyFraction * nav) / maxLoss);
  const perTradeCapLots = floorNonNeg(((mandate.maxPremiumAtRiskPctPerTrade / 100) * nav) / maxLoss);
  const bookRemainingUsd = Math.max((mandate.maxPremiumAtRiskPctBook / 100) * nav - (input.bookPremiumAtRiskUsd ?? 0), 0);
  const bookCapLots = floorNonNeg(bookRemainingUsd / maxLoss);

  let vegaCapLots: number | null = null;
  if (input.vegaPerLot != null && Math.abs(input.vegaPerLot) > 1e-9) {
    const maxBookVegaUsd = (mandate.maxBookVegaPctPerVolPt / 100) * nav;
    const remainingVegaUsd = Math.max(maxBookVegaUsd - Math.abs(input.bookVegaUsd ?? 0), 0);
    vegaCapLots = floorNonNeg(remainingVegaUsd / Math.abs(input.vegaPerLot));
  }

  const limits: [OptionSizingConstraint, number][] = [
    ["kelly", kellyLots],
    ["premium_per_trade", perTradeCapLots],
    ["premium_book", bookCapLots],
  ];
  if (vegaCapLots != null) limits.push(["vega_budget", vegaCapLots]);

  let bindingConstraint: OptionSizingConstraint = "kelly";
  let qty = kellyLots;
  for (const [name, lots] of limits) {
    if (lots < qty) {
      qty = lots;
      bindingConstraint = name;
    }
  }
  qty = Math.max(qty, 0);

  const capitalAtRiskUsd = qty * maxLoss;
  return {
    qty,
    capitalAtRiskUsd: Math.round(capitalAtRiskUsd),
    capitalAtRiskPct: Math.round((capitalAtRiskUsd / nav) * 1000) / 10,
    kellyFraction: Math.round(kellyFraction * 1000) / 1000,
    kellyLots,
    perTradeCapLots,
    bookCapLots,
    vegaCapLots,
    bindingConstraint,
  };
}

// --- Book-level mandate compliance (for the War Room) ------------------------

export type OptionsMandateViolation = { rule: string; severity: "violation" | "warning"; detail: string };

export type OptionsMandateInput = {
  navUsd: number;
  premiumAtRiskPct: number; // book worst-case loss / NAV, %
  bookVegaUsd: number; // signed
  netDeltaUsd: number; // signed beta-weighted delta notional
  shortGammaNearExpiry: number; // count of open short-gamma structures inside the DTE guard
  mandate?: OptionsMandate;
};

export function checkOptionsMandate(input: OptionsMandateInput): OptionsMandateViolation[] {
  const m = input.mandate ?? OPTIONS_MANDATE;
  const out: OptionsMandateViolation[] = [];

  if (input.premiumAtRiskPct > m.maxPremiumAtRiskPctBook) {
    out.push({
      rule: "Book premium at risk",
      severity: "violation",
      detail: `${input.premiumAtRiskPct.toFixed(1)}% of NAV at risk vs the ${m.maxPremiumAtRiskPctBook}% cap.`,
    });
  } else if (input.premiumAtRiskPct > 0.85 * m.maxPremiumAtRiskPctBook) {
    out.push({
      rule: "Book premium at risk",
      severity: "warning",
      detail: `${input.premiumAtRiskPct.toFixed(1)}% of NAV at risk, approaching the ${m.maxPremiumAtRiskPctBook}% cap.`,
    });
  }

  const vegaPct = input.navUsd > 0 ? (Math.abs(input.bookVegaUsd) / input.navUsd) * 100 : 0;
  if (vegaPct > m.maxBookVegaPctPerVolPt) {
    out.push({
      rule: "Book vega budget",
      severity: "violation",
      detail: `${vegaPct.toFixed(2)}% of NAV per vol point (${input.bookVegaUsd >= 0 ? "long" : "short"} vega) vs the ${m.maxBookVegaPctPerVolPt}% cap.`,
    });
  }

  const deltaPct = input.navUsd > 0 ? (Math.abs(input.netDeltaUsd) / input.navUsd) * 100 : 0;
  if (deltaPct > m.maxNetDeltaPctNav) {
    out.push({
      rule: "Net delta",
      severity: "warning",
      detail: `Beta-weighted net delta is ${deltaPct.toFixed(0)}% of NAV (${input.netDeltaUsd >= 0 ? "long" : "short"}) vs the ${m.maxNetDeltaPctNav}% guide.`,
    });
  }

  if (input.shortGammaNearExpiry > 0) {
    out.push({
      rule: "Gamma near expiry",
      severity: "warning",
      detail: `${input.shortGammaNearExpiry} short-gamma structure${input.shortGammaNearExpiry === 1 ? "" : "s"} inside ${m.gammaNearExpiryDte} DTE — pin and assignment risk is live.`,
    });
  }

  return out;
}
