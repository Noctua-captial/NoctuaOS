import { describe, it, expect } from "vitest";
import { selectDirectiveAction, type DirectiveDecisionState } from "@/lib/oracle";

// A neutral, healthy "no position" baseline; each test overrides only what it exercises.
const flat: DirectiveDecisionState = {
  hasPosition: false,
  dataBroken: false,
  posterior: 0.5,
  ev90dPct: 5,
  valuationOnFile: true,
  hasHeadroom: true,
  headroomPct: 5,
  thesisBroken: false,
  pHitKill: 0.1,
  mandateBreach: false,
  regimeStressed: false,
  optionsLiquid: false,
};

const act = (over: Partial<DirectiveDecisionState>) => selectDirectiveAction({ ...flat, ...over }).action;

describe("selectDirectiveAction — no position", () => {
  it("AVOIDs when price/posterior data is broken", () => {
    expect(act({ dataBroken: true, posterior: 0.9 })).toBe("AVOID");
  });

  it("AVOIDs a low-posterior name", () => {
    expect(act({ posterior: 0.4 })).toBe("AVOID");
    expect(act({ posterior: 0.39 })).toBe("AVOID");
  });

  it("AVOIDs when the memo math offers no payable upside", () => {
    expect(act({ posterior: 0.8, ev90dPct: -2, valuationOnFile: true })).toBe("AVOID");
  });

  it("does not AVOID on non-positive EV when no valuation is on file", () => {
    // Falls through to HOLD rather than AVOID (no targets to trust).
    expect(act({ posterior: 0.55, ev90dPct: -2, valuationOnFile: false })).toBe("HOLD");
  });

  it("BUYs a high-conviction, high-EV idea with headroom", () => {
    expect(act({ posterior: 0.62, ev90dPct: 8.1, hasHeadroom: true })).toBe("BUY");
  });

  it("HOLDs when the BUY gate is not fully cleared", () => {
    expect(act({ posterior: 0.62, ev90dPct: 8.1, hasHeadroom: false })).toBe("HOLD"); // no headroom
    expect(act({ posterior: 0.6, ev90dPct: 20 })).toBe("HOLD"); // posterior below BUY gate
    expect(act({ posterior: 0.7, ev90dPct: 5 })).toBe("HOLD"); // EV below the BUY floor
  });
});

describe("selectDirectiveAction — with position (precedence EXIT > TRIM > ADD > HEDGE > HOLD)", () => {
  const held: Partial<DirectiveDecisionState> = { hasPosition: true };

  it("EXITs a broken thesis even at high posterior", () => {
    expect(act({ ...held, thesisBroken: true, posterior: 0.7 })).toBe("EXIT");
  });

  it("EXITs when posterior falls below the exit gate", () => {
    expect(act({ ...held, posterior: 0.34 })).toBe("EXIT");
  });

  it("TRIMs on a weak posterior, high kill probability, or a mandate breach", () => {
    expect(act({ ...held, posterior: 0.49 })).toBe("TRIM");
    expect(act({ ...held, posterior: 0.6, pHitKill: 0.45 })).toBe("TRIM");
    expect(act({ ...held, posterior: 0.6, mandateBreach: true })).toBe("TRIM");
  });

  it("ADDs to a strong position with headroom and low kill risk", () => {
    expect(act({ ...held, posterior: 0.66, hasHeadroom: true, pHitKill: 0.1 })).toBe("ADD");
  });

  it("does not ADD without headroom; HEDGEs instead when the regime is stressed and options are liquid", () => {
    expect(act({ ...held, posterior: 0.58, hasHeadroom: false, regimeStressed: true, optionsLiquid: true })).toBe("HEDGE");
  });

  it("HOLDs inside the band when nothing harsher or better applies", () => {
    expect(act({ ...held, posterior: 0.58, hasHeadroom: false, regimeStressed: false })).toBe("HOLD");
  });

  it("prefers TRIM over ADD when both could trigger (de-risking wins)", () => {
    // High posterior would ADD, but a mandate breach forces TRIM first.
    expect(act({ ...held, posterior: 0.7, hasHeadroom: true, mandateBreach: true })).toBe("TRIM");
  });
});
