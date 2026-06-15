import { describe, it, expect } from "vitest";
import { mean, bookVolatility, sizingMath, sizingMathMulti, type SizingInput } from "@/lib/quant";
import { correlatedReturns } from "@/lib/mathlab/__tests__/helpers";

describe("mean", () => {
  it("averages a non-empty array", () => {
    expect(mean([2, 4])).toBe(3);
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it("returns 0 (not NaN) on an empty array", () => {
    expect(mean([])).toBe(0);
    expect(Number.isNaN(mean([]))).toBe(false);
  });
});

describe("bookVolatility", () => {
  it("equals the single-asset vol for one position", () => {
    expect(bookVolatility([1], [0.2], [[1]])).toBeCloseTo(0.2, 10);
  });

  it("computes the uncorrelated two-asset case", () => {
    // √(0.5²·0.2² + 0.5²·0.2²) = √0.02
    expect(bookVolatility([0.5, 0.5], [0.2, 0.2], [[1, 0], [0, 1]])!).toBeCloseTo(Math.sqrt(0.02), 10);
  });

  it("treats unestimable ρ conservatively (higher than assuming 0)", () => {
    const withZero = bookVolatility([0.5, 0.5], [0.2, 0.2], [[1, 0], [0, 1]])!;
    const withUnknown = bookVolatility([0.5, 0.5], [0.2, 0.2], [[1, null], [null, 1]])!; // default 0.5 fill
    expect(withUnknown).toBeGreaterThan(withZero);
    expect(withUnknown).toBeCloseTo(Math.sqrt(0.03), 10);
  });

  it("returns null on shape mismatch", () => {
    expect(bookVolatility([0.5], [0.2, 0.2], [[1]])).toBeNull();
    expect(bookVolatility([], [], [])).toBeNull();
  });
});

describe("sizingMath", () => {
  const base: SizingInput = {
    bearPrice: 95,
    basePrice: 140,
    bullPrice: 200,
    spot: 100,
    annualizedVol: 0.2,
    advDollars: 10_000_000_000, // very liquid → liquidity never binds
    navUsd: 10_000_000,
  };

  it("binds on the mandate cap for a strong, liquid, low-vol idea", () => {
    const out = sizingMath(base);
    expect(out.bindingConstraint).toBe("mandate");
    expect(out.recommendedPct).toBeCloseTo(8, 6);
    expect(out.recommendedPct).toBeGreaterThanOrEqual(0);
  });

  it("binds on the vol target when volatility is extreme", () => {
    const out = sizingMath({ ...base, annualizedVol: 2.0 }); // volTarget = 0.15/2.0 = 7.5%
    expect(out.bindingConstraint).toBe("vol_target");
    expect(out.recommendedPct).toBeCloseTo(7.5, 6);
  });

  it("binds on liquidity when ADV is thin", () => {
    const out = sizingMath({ ...base, advDollars: 80_000 }); // 5·80k·100/10M = 4%
    expect(out.bindingConstraint).toBe("liquidity");
    expect(out.recommendedPct).toBeCloseTo(4, 6);
  });

  it("binds on (half-)Kelly for a weak, symmetric edge", () => {
    const out = sizingMath({ bearPrice: 20, basePrice: 105, bullPrice: 190, spot: 100, annualizedVol: 0.3, advDollars: 1e9, navUsd: 1e7 });
    expect(out.bindingConstraint).toBe("kelly");
    expect(out.recommendedPct).toBeCloseTo(out.kellyHalfPct, 10);
    expect(out.recommendedPct).toBeGreaterThan(0);
    expect(out.recommendedPct).toBeLessThan(8);
  });

  it("recommends zero with no expected upside and never goes negative", () => {
    const out = sizingMath({ bearPrice: 60, basePrice: 80, bullPrice: 100, spot: 100, annualizedVol: 0.3, advDollars: 1e9, navUsd: 1e7 });
    expect(out.kellyPct).toBe(0);
    expect(out.recommendedPct).toBe(0);
  });
});

describe("sizingMathMulti", () => {
  const [cand, b1, b2] = correlatedReturns(55, 250);

  it("produces capped, non-negative weights with a valid CVaR scale", () => {
    const out = sizingMathMulti({ candidateReturns: cand, bookReturnsMatrix: [b1, b2], expectedReturns: [0.0006, 0.0003, 0.0002] });
    expect(out).not.toBeNull();
    expect(out!.candidatePct).toBeLessThanOrEqual(8 + 1e-9);
    expect(out!.weightsPct.every((w) => w >= 0)).toBe(true);
    expect(out!.cvarScale).toBeGreaterThan(0);
    expect(out!.cvarScale).toBeLessThanOrEqual(1);
  });

  it("zeroes the candidate on a negative edge", () => {
    const out = sizingMathMulti({ candidateReturns: cand, bookReturnsMatrix: [b1, b2], expectedReturns: [-0.001, -0.001, -0.001] });
    expect(out).not.toBeNull();
    expect(out!.candidatePct).toBe(0);
  });

  it("returns null on mismatched expectedReturns length", () => {
    expect(sizingMathMulti({ candidateReturns: cand, bookReturnsMatrix: [b1], expectedReturns: [0.1, 0.1, 0.1] })).toBeNull();
  });
});
