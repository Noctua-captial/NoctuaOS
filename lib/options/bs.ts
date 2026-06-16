// Black-Scholes-Merton pricing + greeks, no dividend. Pure functions, used to
// reprice still-alive legs at an evaluation horizon (calendars/diagonals), to
// fill theta (the CBOE chain carries delta/gamma/vega but not theta), and to
// mark structures to model when a live quote is missing. Greeks are quoted the
// way a desk reads them: vega per 1 vol POINT, theta per CALENDAR day.
const DEFAULT_RATE = 0.04;

/** Standard normal CDF — Abramowitz & Stegun 26.2.17, |error| < 7.5e-8. */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function normPdf(x: number): number {
  return 0.3989422804014327 * Math.exp((-x * x) / 2);
}

export type Right = "C" | "P";

export type Greeks = {
  price: number; // per share
  delta: number; // per $1 of underlying
  gamma: number; // per $1 of underlying, per $1
  vega: number; // per 1 vol POINT (i.e. per 0.01 of IV)
  theta: number; // per CALENDAR day (negative for long premium)
};

/** Intrinsic value per share at expiry. */
export function intrinsic(right: Right, spot: number, strike: number): number {
  return right === "C" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
}

/**
 * BSM price + greeks. `years` is time to expiry in years; `vol` is annualized
 * decimal IV. Degrades to intrinsic (delta a step, other greeks 0) at/!past
 * expiry or on junk vol so callers never get NaN.
 */
export function blackScholes(
  right: Right,
  spot: number,
  strike: number,
  vol: number,
  years: number,
  rate = DEFAULT_RATE,
): Greeks {
  if (!(spot > 0) || !(strike > 0) || !(years > 0) || !(vol > 0) || !Number.isFinite(vol)) {
    const price = intrinsic(right, spot, strike);
    const delta = right === "C" ? (spot > strike ? 1 : 0) : spot < strike ? -1 : 0;
    return { price, delta, gamma: 0, vega: 0, theta: 0 };
  }
  const sT = vol * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate + (vol * vol) / 2) * years) / sT;
  const d2 = d1 - sT;
  const df = Math.exp(-rate * years);
  const pdf = normPdf(d1);

  let price: number;
  let delta: number;
  let theta: number;
  if (right === "C") {
    price = spot * normCdf(d1) - strike * df * normCdf(d2);
    delta = normCdf(d1);
    theta = (-(spot * pdf * vol) / (2 * Math.sqrt(years)) - rate * strike * df * normCdf(d2)) / 365;
  } else {
    price = strike * df * normCdf(-d2) - spot * normCdf(-d1);
    delta = normCdf(d1) - 1;
    theta = (-(spot * pdf * vol) / (2 * Math.sqrt(years)) + rate * strike * df * normCdf(-d2)) / 365;
  }
  const gamma = pdf / (spot * sT);
  const vega = (spot * pdf * Math.sqrt(years)) / 100; // per 1 vol point

  return { price, delta, gamma, vega, theta };
}

/** Just the price (for repricing surviving legs at a horizon). */
export function bsPrice(right: Right, spot: number, strike: number, vol: number, years: number, rate = DEFAULT_RATE): number {
  return blackScholes(right, spot, strike, vol, years, rate).price;
}
