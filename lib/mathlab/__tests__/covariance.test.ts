import { describe, it, expect } from "vitest";
import { shrinkCovariance, multivariateKelly, cvarConstrainedScale } from "@/lib/mathlab/covariance";
import { correlatedReturns } from "./helpers";

const matrix = correlatedReturns(99, 300);

describe("shrinkCovariance (Ledoit-Wolf)", () => {
  const shrunk = shrinkCovariance(matrix);

  it("produces a shrinkage intensity in [0,1]", () => {
    expect(shrunk).not.toBeNull();
    expect(shrunk!.shrinkage).toBeGreaterThanOrEqual(0);
    expect(shrunk!.shrinkage).toBeLessThanOrEqual(1);
  });

  it("returns a symmetric matrix with positive diagonal", () => {
    const cov = shrunk!.cov;
    for (let i = 0; i < 3; i++) {
      expect(cov[i][i]).toBeGreaterThan(0);
      for (let j = 0; j < 3; j++) expect(Math.abs(cov[i][j] - cov[j][i])).toBeLessThan(1e-15);
    }
  });

  it("returns null on singular / too-short input", () => {
    expect(shrinkCovariance([[0.01, 0.02]])).toBeNull();
    expect(shrinkCovariance([])).toBeNull();
  });
});

describe("multivariateKelly", () => {
  const cov = shrinkCovariance(matrix)!.cov;

  it("respects per-name and gross caps with a strong edge", () => {
    const w = multivariateKelly({ expectedReturns: [0.0008, 0.0006, 0.0004], cov, capPerName: 0.08, grossCap: 0.9 });
    expect(w).not.toBeNull();
    expect(w!.every((x) => x >= 0 && x <= 0.08 + 1e-12)).toBe(true);
    expect(w!.reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(0.9 + 1e-12);
    expect(w![0]).toBeGreaterThanOrEqual(0.08 - 1e-9); // strong edge pins the cap
  });

  it("keeps a weak edge interior (below the cap, still positive somewhere)", () => {
    const w = multivariateKelly({ expectedReturns: [5e-6, 4e-6, 3e-6], cov, capPerName: 0.08, grossCap: 0.9 });
    expect(w).not.toBeNull();
    expect(w!.every((x) => x < 0.08)).toBe(true);
    expect(w!.some((x) => x > 0)).toBe(true);
  });

  it("clips negative Kelly weights to zero (long-only)", () => {
    const w = multivariateKelly({ expectedReturns: [-0.01, -0.01, -0.01], cov, capPerName: 0.08, grossCap: 0.9 });
    expect(w).not.toBeNull();
    expect(w!.every((x) => x === 0)).toBe(true);
  });

  it("rejects degenerate config", () => {
    expect(multivariateKelly({ expectedReturns: [], cov: [], capPerName: 0.08, grossCap: 0.9 })).toBeNull();
    expect(multivariateKelly({ expectedReturns: [0.01], cov, capPerName: 0, grossCap: 0.9 })).toBeNull();
  });
});

describe("cvarConstrainedScale", () => {
  it("scales down under a tight CVaR limit and stays slack under a loose one", () => {
    const tight = cvarConstrainedScale([0.5, 0.3, 0.2], matrix, 0.2);
    const loose = cvarConstrainedScale([0.5, 0.3, 0.2], matrix, 50);
    expect(tight).not.toBeNull();
    expect(tight!).toBeGreaterThan(0);
    expect(tight!).toBeLessThan(1);
    expect(loose).toBe(1);
  });

  it("is positively homogeneous (CVaR scale ∝ 1/size)", () => {
    const base = cvarConstrainedScale([0.5, 0.3, 0.2], matrix, 0.2)!;
    const doubled = cvarConstrainedScale([1.0, 0.6, 0.4], matrix, 0.2)!;
    // Doubling the weights halves the admissible scale.
    expect(doubled).toBeCloseTo(base / 2, 6);
  });

  it("returns null on shape mismatch", () => {
    expect(cvarConstrainedScale([0.5, 0.5], matrix, 1)).toBeNull();
  });
});
