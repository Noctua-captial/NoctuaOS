import { db, tables } from "./index";

async function seed() {
  // wipe in dependency order
  db.delete(tables.alerts).run();
  db.delete(tables.memos).run();
  db.delete(tables.scores).run();
  db.delete(tables.catalysts).run();
  db.delete(tables.claims).run();
  db.delete(tables.theses).run();
  db.delete(tables.companies).run();

  const [tsem] = db
    .insert(tables.companies)
    .values({
      ticker: "TSEM",
      name: "Tower Semiconductor",
      sector: "Semiconductors — Specialty Foundry",
      marketCap: "$5.8B",
      liquidity: "$42M ADV",
      status: "active",
      thesisStatus: "strengthening",
      convictionScore: 82,
      ownerAnalyst: "R. Salman",
      businessSummary:
        "Specialty analog foundry (SiGe, SiPho, RF, power management) with leverage to optical interconnect demand in AI data centers. Underfollowed relative to leading-edge logic names.",
    })
    .returning()
    .all();

  const [mu] = db
    .insert(tables.companies)
    .values({
      ticker: "MU",
      name: "Micron Technology",
      sector: "Semiconductors — Memory",
      marketCap: "$142B",
      liquidity: "$1.9B ADV",
      status: "active",
      thesisStatus: "stable",
      convictionScore: 74,
      ownerAnalyst: "R. Salman",
      businessSummary:
        "One of three HBM-capable DRAM manufacturers. AI inference workloads are structurally increasing demand for memory bandwidth; HBM supply is sold out through next year.",
    })
    .returning()
    .all();

  const [aehr] = db
    .insert(tables.companies)
    .values({
      ticker: "AEHR",
      name: "Aehr Test Systems",
      sector: "Semiconductors — Test Equipment",
      marketCap: "$420M",
      liquidity: "$6.1M ADV",
      status: "watchlist",
      thesisStatus: "weakening",
      convictionScore: 58,
      ownerAnalyst: "R. Salman",
      businessSummary:
        "Wafer-level burn-in test systems. Original SiC thesis impaired by EV slowdown; potential second act in AI processor burn-in remains unproven.",
    })
    .returning()
    .all();

  const [apld] = db
    .insert(tables.companies)
    .values({
      ticker: "APLD",
      name: "Applied Digital",
      sector: "AI Infrastructure — Data Centers",
      marketCap: "$2.4B",
      liquidity: "$95M ADV",
      status: "watchlist",
      thesisStatus: "stable",
      convictionScore: 64,
      ownerAnalyst: "Unassigned",
      businessSummary:
        "HPC data-center developer with access to stranded power in North Dakota. Optionality on hyperscaler leases; balance-sheet risk from build-out financing.",
    })
    .returning()
    .all();

  const [leu] = db
    .insert(tables.companies)
    .values({
      ticker: "LEU",
      name: "Centrus Energy",
      sector: "Nuclear Fuel — Enrichment",
      marketCap: "$3.1B",
      liquidity: "$58M ADV",
      status: "rejected",
      thesisStatus: "stable",
      convictionScore: 41,
      ownerAnalyst: "R. Salman",
      rejectionReason:
        "Rejected 2026-03: 84% of revenue depends on a single TENEX supply contract exposed to sanctions risk; HALEU revenue too far out to underwrite. Reopen if domestic enrichment capacity contracts are signed.",
      businessSummary:
        "Only US-licensed HALEU enrichment company. Long-term beneficiary of nuclear restart theme but near-term revenue concentrated in Russian-sourced LEU resale.",
    })
    .returning()
    .all();

  // ---- TSEM dossier depth ----
  db.insert(tables.theses)
    .values({
      companyId: tsem.id,
      version: 2,
      oneLiner:
        "The market prices TSEM as a legacy analog foundry while its silicon photonics platform is becoming a critical bottleneck for AI optical interconnect.",
      variantPerception:
        "Consensus models SiPho as a niche segment. Noctua's supply-chain work suggests 800G/1.6T transceiver demand makes TSEM one of the few merchant foundries positioned for the optical transition.",
      whyMarketWrong:
        "Sell-side coverage is thin and anchored to trailing utilization. The Intel deal collapse left a narrative overhang that obscures the SiPho ramp.",
      whyNow:
        "Hyperscaler capex guidance implies optical interconnect attach rates inflect over the next 12 months; TSEM capacity decisions are being made now.",
      whatMustHappen: JSON.stringify([
        "SiPho revenue becomes a disclosed, growing segment within 4 quarters",
        "Specialty analog utilization recovers above 75%",
        "At least one major transceiver customer publicly ramps on TSEM process",
      ]),
      killCriteria: JSON.stringify([
        "SiPho design wins migrate to internal foundries (Intel, GlobalFoundries) — exit",
        "Utilization stagnates below 70% for two consecutive quarters — halve position",
        "Optical attach-rate thesis breaks at hyperscaler level — exit",
      ]),
    })
    .run();

  db.insert(tables.claims)
    .values([
      {
        companyId: tsem.id,
        text: "SiPho and SiGe revenue grew >40% YoY per latest earnings call.",
        kind: "fact",
        supports: "bull",
        confidence: 0.92,
        source: "Q1 FY26 earnings transcript",
        sourceType: "transcript",
      },
      {
        companyId: tsem.id,
        text: "800G transceiver demand makes merchant SiPho foundry capacity a structural bottleneck through 2027.",
        kind: "inference",
        supports: "bull",
        confidence: 0.71,
        source: "Supply-chain checks + hyperscaler capex commentary",
        sourceType: "analyst_note",
      },
      {
        companyId: tsem.id,
        text: "Specialty analog utilization remains below pre-2023 levels; recovery timing is a model assumption, not evidence.",
        kind: "model_assumption",
        supports: "bear",
        confidence: 0.55,
        source: "Internal model v3",
        sourceType: "analyst_note",
      },
      {
        companyId: tsem.id,
        text: "Related foundry commentary (X-FAB, Vanguard) suggests stronger-than-expected demand in specialty analog.",
        kind: "inference",
        supports: "bull",
        confidence: 0.63,
        source: "Competitor earnings calls",
        sourceType: "competitor",
      },
    ])
    .run();

  db.insert(tables.catalysts)
    .values([
      {
        companyId: tsem.id,
        title: "Q2 FY26 earnings — first possible SiPho segment disclosure",
        kind: "earnings",
        expectedDate: "2026-08-05",
        impact: "Segment disclosure would force re-rating of the SiPho business",
      },
      {
        companyId: tsem.id,
        title: "New Mexico fab capacity announcement",
        kind: "guidance",
        expectedDate: "Q3 2026",
        impact: "Confirms demand visibility behind capex commitment",
      },
    ])
    .run();

  db.insert(tables.scores)
    .values({
      companyId: tsem.id,
      total: 82,
      components: JSON.stringify({
        thesisClarity: 9,
        evidenceQuality: 13,
        variantPerception: 13,
        asymmetry: 12,
        valuationGap: 8,
        catalystStrength: 8,
        managementQuality: 4,
        balanceSheet: 4,
        technicalEdge: 8,
        liquidityRiskFit: 3,
      }),
      rationale:
        "Score 82: evidence quality is strong, variant perception is high, catalyst is near-term, but liquidity and balance-sheet risk reduce position size.",
    })
    .run();

  // ---- MU depth ----
  db.insert(tables.theses)
    .values({
      companyId: mu.id,
      version: 1,
      oneLiner:
        "AI inference workloads structurally increase memory-bandwidth demand; HBM converts DRAM from a commodity cycle into a capacity-constrained, negotiated market.",
      variantPerception:
        "Market still applies trough-cycle multiples assuming mean reversion. Noctua view: HBM take-or-pay agreements and capex discipline have changed the cycle's shape.",
      whyMarketWrong: "Anchoring to two decades of DRAM cyclicality.",
      whyNow: "HBM3E allocation for next year nearly sold out; pricing power visible in next two prints.",
      whatMustHappen: JSON.stringify([
        "HBM mix continues to expand as % of revenue",
        "Industry capex discipline holds (no Samsung capacity flood)",
      ]),
      killCriteria: JSON.stringify([
        "Samsung HBM qualification at scale triggers price war — exit",
        "Inference demand growth decelerates below GPU shipment growth — reassess",
      ]),
    })
    .run();

  db.insert(tables.claims)
    .values([
      {
        companyId: mu.id,
        text: "HBM demand commentary from SK Hynix supports the memory-bandwidth thesis.",
        kind: "fact",
        supports: "bull",
        confidence: 0.88,
        source: "SK Hynix earnings call",
        sourceType: "competitor",
      },
      {
        companyId: mu.id,
        text: "Valuation has expanded since entry, reducing asymmetry versus original thesis.",
        kind: "fact",
        supports: "bear",
        confidence: 0.9,
        source: "Internal valuation model",
        sourceType: "analyst_note",
      },
    ])
    .run();

  db.insert(tables.catalysts)
    .values([
      {
        companyId: mu.id,
        title: "FQ4 earnings — HBM pricing and supply/demand clarity",
        kind: "earnings",
        expectedDate: "2026-06-25",
        impact: "Clarifies pricing power; thesis checkpoint",
      },
    ])
    .run();

  db.insert(tables.scores)
    .values({
      companyId: mu.id,
      total: 74,
      components: JSON.stringify({
        thesisClarity: 9,
        evidenceQuality: 13,
        variantPerception: 10,
        asymmetry: 9,
        valuationGap: 6,
        catalystStrength: 8,
        managementQuality: 4,
        balanceSheet: 4,
        technicalEdge: 8,
        liquidityRiskFit: 3,
      }),
      rationale:
        "Score 74: thesis intact and evidence strengthening, but expected return is lower than at entry after multiple expansion. Hold; do not add above base-case threshold.",
    })
    .run();

  // ---- AEHR / APLD / LEU light data ----
  db.insert(tables.theses)
    .values({
      companyId: aehr.id,
      version: 3,
      oneLiner:
        "Original SiC burn-in thesis broken by EV slowdown; remaining bet is unproven AI processor burn-in adoption.",
      variantPerception: "None currently — market and Noctua now broadly agree.",
      whyNow: "Awaiting evidence of AI burn-in orders.",
      whatMustHappen: JSON.stringify(["A bookable AI processor burn-in order from a hyperscaler-adjacent customer"]),
      killCriteria: JSON.stringify(["No AI burn-in order within 2 quarters — remove from watchlist"]),
    })
    .run();

  db.insert(tables.catalysts)
    .values([
      {
        companyId: apld.id,
        title: "Hyperscaler lease announcement for Ellendale campus",
        kind: "contract",
        expectedDate: "Q3 2026",
        impact: "Converts speculative capacity into contracted revenue",
      },
      {
        companyId: aehr.id,
        title: "FQ4 earnings — first possible AI burn-in bookings",
        kind: "earnings",
        expectedDate: "2026-07-14",
        impact: "Only event that can revive the thesis",
      },
    ])
    .run();

  // ---- The Perch attention queue ----
  db.insert(tables.alerts)
    .values([
      {
        companyId: aehr.id,
        ticker: "AEHR",
        severity: 1,
        kind: "thesis_break",
        message:
          "Thesis condition broken: SiC bookings fell for a third consecutive quarter, violating kill criterion #2 of memo v3.",
        suggestedAction: "Convene IC review. Decide: exit watchlist or re-underwrite as AI burn-in optionality.",
      },
      {
        companyId: tsem.id,
        ticker: "TSEM",
        severity: 2,
        kind: "signal",
        message:
          "NIGHT VISION — Related foundry commentary suggests stronger-than-expected demand in specialty analog. Supports thesis point #3. Confidence: Medium.",
        suggestedAction: "Update industry comp table before next IC meeting.",
      },
      {
        companyId: mu.id,
        ticker: "MU",
        severity: 2,
        kind: "catalyst",
        message: "Catalyst approaching: FQ4 earnings in 14 days. HBM pricing commentary is the thesis checkpoint.",
        suggestedAction: "Pre-register expectations: write down predicted HBM mix and pricing language before the print.",
      },
      {
        companyId: leu.id,
        ticker: "LEU",
        severity: 3,
        kind: "stale_thesis",
        message:
          "Previously rejected on customer concentration (84% TENEX). New DOE enrichment RFP could change revenue mix. Reopen research?",
        suggestedAction: "Assign Dossier Agent to refresh contract mix analysis.",
      },
      {
        companyId: apld.id,
        ticker: "APLD",
        severity: 4,
        kind: "noise_drop",
        message:
          "Stock down 9% on sector-wide AI infrastructure rotation. No company-specific news. Fundamentals unchanged.",
        suggestedAction: "No action. Flag as potential add if weakness persists below base-case threshold.",
      },
    ])
    .run();

  // ---- TSEM IC memo (v2) ----
  db.insert(tables.memos)
    .values({
      companyId: tsem.id,
      version: 2,
      analyst: "R. Salman",
      proposedAction: "Increase long position",
      proposedSize: "4.5% of NAV (from 3.0%)",
      recommendation: "approve",
      content: JSON.stringify({
        oneSentenceThesis:
          "The market prices TSEM as a legacy analog foundry while its silicon photonics platform is becoming a critical bottleneck for AI optical interconnect.",
        variantPerception:
          "Consensus treats SiPho as a niche line item. Supply-chain work indicates TSEM is one of two merchant foundries qualified for high-volume 800G/1.6T transceiver photonics.",
        whyNow:
          "Hyperscaler capex guidance implies optical attach rates inflect within 12 months; capacity is being booked now.",
        businessQuality:
          "Specialty foundry with sticky design wins, 10+ year customer relationships, net cash balance sheet. Margins below leading-edge peers but stable.",
        industryContext:
          "AI data-center power and bandwidth constraints push the industry toward optical interconnect. Photonics foundry capacity is the bottleneck, not transceiver assembly.",
        evidenceTable: [
          {
            claim: "SiPho/SiGe revenue +40% YoY",
            evidence: "Management disclosure",
            source: "Q1 FY26 transcript",
            confidence: "High",
            updated: "2026-05-12",
          },
          {
            claim: "Merchant SiPho capacity is scarce",
            evidence: "Two transceiver vendors cite foundry constraints",
            source: "Supply-chain checks",
            confidence: "Medium",
            updated: "2026-05-28",
          },
        ],
        valuation: {
          bear: "$38 — SiPho stalls, utilization flat. 12x trough EPS.",
          base: "$62 — SiPho disclosed segment growing 35%+, utilization recovers. 14x FY27 EPS.",
          bull: "$85 — SiPho becomes 20% of revenue, multiple re-rates toward photonics peers.",
        },
        catalysts: ["Q2 FY26 earnings (Aug 5) — possible segment disclosure", "Capacity announcement Q3 2026"],
        bearCase:
          "SiPho design wins migrate to internal foundries; specialty analog stays in over-supply; Israel geopolitical risk discount persists indefinitely.",
        killCriteria: [
          "SiPho design wins migrate to internal foundries — exit",
          "Utilization < 70% for two consecutive quarters — halve",
          "Hyperscaler optical attach-rate thesis breaks — exit",
        ],
        positionSizing:
          "4.5% NAV. Not bigger: single-fab geographic concentration and thin sell-side coverage extend re-rating timeline. Not smaller: asymmetry ~3:1 with near-term catalyst.",
        monitoringPlan:
          "Weekly: transceiver vendor commentary, competitor utilization. Quarterly: SiPho revenue trajectory, utilization, hyperscaler capex revisions.",
        dissent:
          "Strix: 'The SiPho ramp is real but TSEM has no pricing power over its anchor customers; the bottleneck rent accrues to transceiver designers, not the foundry. You are long the right theme through the wrong layer of the stack.'",
        finalRecommendation: "Approve — increase to 4.5% with kill criteria as stated.",
      }),
    })
    .run();

  console.log("Seeded Noctua OS database.");
}

seed();
