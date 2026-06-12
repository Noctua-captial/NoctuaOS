# NOCTUA OS

Private decision-intelligence terminal for Noctua Capital. Not a dashboard — a system that forces every idea through: **thesis → evidence → dissent → valuation → sizing → monitoring → postmortem**.

## Modules

| Module | Route | What it is |
| --- | --- | --- |
| The Perch | `/` | Daily command center. Attention queue ranked by importance, not price moves. Live Talons P&L panel and the Night Vision scan trigger. |
| Dossiers | `/dossiers`, `/dossiers/[ticker]` | Living research pages: thesis (versioned), evidence with claim taxonomy (fact / inference / opinion / model assumption / unverified), explainable Noctua Score, catalysts, kill criteria, primary sources on file. Header carries the live quote, day change, and sparkline; the valuation model is seeded from real fundamentals. |
| The Vault | `/vault` | Evidence & document system. Ingests real SEC filings from EDGAR (free, no key — 10-K/10-Q/8-K and 20-F/6-K for foreign issuers), manual transcript/note upload, FTS5 keyword retrieval (+ embeddings when an OpenAI key is configured), and grounded Q&A with citations. **No source, no claim.** |
| IC Chamber | `/ic`, `/ic/[id]` | Versioned investment-committee memos, rendered as parchment documents. 14 sections + required next diligence. Approval flows straight into opening a Talons position. |
| Talons | `/talons` | Positions module. Open positions with live P&L vs entry, thesis-status chips, gross and theme-weighted exposure, drawdown-from-entry. Closing a position demands an After-Action postmortem. |
| Night Vision | Perch scan / `/api/nightvision/scan` | Automatic monitoring sweep: new-filing detection with auto-ingest, >8% price moves, catalyst T-7 reminders, stale theses, rejected-name reopen watch. With a provider key, the relevance agent reads new filings against the thesis and raises branded signal alerts. Throttled to one sweep per 10 minutes. |
| Alpha Ledger | `/ledger` | Research traces and agent run history. Every agent action becomes a structured trace: question → action → observation → interpretation → confidence change → next action → reasoning pattern. Traces are human-labelable (strong_signal / weak_signal / false_positive / noise) and exportable as JSONL via `/api/export/traces`. This is the training-data moat. |
| Model Lab | `/lab` | Provider key status, per-agent routing table with fallback chains, recent runs per model. Every agent slot is env-overridable. |
| Athena | `/new` | The killer workflow: ticker in → full Symposium → adversarial, sourced, scored IC memo out. |
| War Room | `/war-room` | Regime read (SP500 trend/vol via FRED, keyless), mandate compliance with violation flags, council navigation briefs (PM + Risk + Strix), approvable trim/add/exit proposals. |
| Debate Chamber | `/debates/[id]` | Full transcripts: Advocate vs Strix vs The Quant across four rounds, moderated verdict with conviction, the crux, and its resolving evidence. |
| Athena Chat | α button on dossiers | Dossier copilot drawer with Vault, quote, fundamentals, claim, and catalyst tools. Degrades to an explicit offline state without a key. |
| Command Bar | `⌘K` anywhere | The primary interface: fuzzy search across companies/memos/modules, plus actions — "Investigate X with Athena", "Pull X filings into the Vault", "Scan Night Vision". |
| Research Graph | `/dossiers/[ticker]/graph` | Interactive canvas of the thesis graph: draggable nodes, pan/zoom, click-to-inspect. Bull/bear evidence, catalysts, memos, agent runs. |

### Workflow (all wired, no dead buttons)

- **IC decisions** — every memo has an approve / more-work / reject bar (two-click confirm, decided-by name). Decisions update company status, post to the Perch queue, and log a trace in the Alpha Ledger. Approval prefills an open-position step with the live quote and memo sizing.
- **Positions** — open positions track live P&L vs entry on `/talons` and the Perch panel; closing one requires an After-Action postmortem (outcome, thesis right / right-for-wrong-reason, timing, sizing, lessons) shown on the dossier and `/ledger`.
- **Monitoring** — the NIGHT VISION SCAN button on the Perch (or the ⌘K action) sweeps coverage and streams progress live; new filings auto-ingest to the Vault and raise alerts.
- **Learning loop** — traces are labeled in the Alpha Ledger; closing positions stamps trace outcomes; `/api/export/traces` emits the JSONL fine-tuning dataset.
- **Status controls** — company status and thesis status editable on every dossier; marking a thesis `broken` auto-raises a CRITICAL alert.
- **Attention queue** — alerts are resolvable; severity-ranked with left-border coding.
- **Evidence** — filterable by side and claim kind; analysts add claims inline (source required — no source, no claim).
- **Market data** — live quotes via Yahoo with Stooq fallback, cached ~10 min; EDGAR XBRL fundamentals feed dossier headers and the valuation model. All of it keyless.
- **Thesis exposure** — the Perch shows theme concentration across the book ("one bet can wear five tickers").

### Agent bench

Every investigation runs eight agents, each grounded in Vault excerpts when filings are on file:

1. **Dossier/Thesis Agent** — company background + cleanest possible bull case
2. **Accounting Agent** — dilution, revenue quality, working capital, customer concentration
3. **Industry Agent** — technical reality check: is the AI exposure real or management language?
4. **Catalyst Agent** — re-rating event map with probabilities; states the no-catalyst risk
5. **Valuation Agent** — bear/base/bull with the assumptions that actually drive the spread
6. **Strix** — adversarial bear agent; attacks the thesis *and* the bench's findings; produces kill criteria. No Strix report, no memo.
7. **Evidence Auditor** — audits every claim against Vault sources; downgrades unsupported claims; identifies the weakest link
8. **Athena synthesis** — explainable Noctua Score + IC memo + next diligence steps

Each agent emits a research trace (stored in `traces`) and a full report (stored in `agent_runs`).

### The Symposium (investigation pipeline)

`vault → dossier → quant snapshot → specialist bench → recursive research tree → logic audit → strix → evidence audit → debate → synthesis`

- **Quant bench** (`lib/quant.ts`, keyless): annualized vol, beta vs the FRED SP500 benchmark, max drawdown, 52w distance, momentum, RSI, EV/Revenue, EV/EBIT, P/E from real fundamentals; pairwise correlations vs the book; Kelly / vol-target / liquidity / mandate sizing math with the binding constraint named.
- **Recursive tree** (`lib/symposium.ts`): the thesis is decomposed into 3-5 load-bearing questions; low-confidence answers spawn sharper child questions (depth ≤ 3, budget `NOCTUA_TREE_BUDGET`, default 6). Every node is persisted and traced.
- **Logic Auditor**: formalizes the thesis as premises → inference → conclusion, flags non-sequiturs and unsupported premises, checks the science.
- **Debate Chamber**: Advocate (Fable), Strix (Grok), and The Quant (GPT, argues only from the quant numbers) across openings → rebuttals → moderator-posed crux → final probabilities; Athena (Opus) delivers the verdict. The unresolved crux becomes a pending research question.

### The War Room (managing the book)

- **Sizing Council** (`/api/sizing`): deterministic Kelly/vol/liquidity/mandate math from memo scenario prices + live vol, surfaced in the open-position flow with an ADOPT button; a Risk+PM deliberation layer runs when keys exist.
- **The Mandate** (`lib/quant.ts` `MANDATE`, env-overridable `NOCTUA_MANDATE_*`): max position 8%, max theme 25%, cash floor 5%, beta ceiling 1.6, 15% vol target.
- **Council briefs** (`/api/warroom/brief`): PM proposes, Risk constrains, Strix attacks — per-position hold/trim/add/exit with size deltas, cash stance, and "what would change our mind"; every proposal is an approvable card that executes through the position actions and logs a trace.
- The training-data export (`/api/export/traces`) now emits traces, full debate transcripts, and council briefs as typed JSONL records.

## Stack

- Next.js (App Router) + Tailwind v4
- SQLite + Drizzle ORM (`noctua.db` in repo root, gitignored data file)
- Vercel AI SDK — multi-model router (`lib/models.ts`): xAI / Anthropic / OpenAI per agent, with key-availability fallback chains

## Setup

```bash
npm install
npx drizzle-kit push      # create schema
npx tsx db/seed.ts        # seed example dossiers (TSEM, MU, AEHR, APLD, LEU)
npm run dev
```

### AI pipeline

Add any of the three provider keys to `.env.local` — the router falls through to whatever is live:

```bash
XAI_API_KEY=...        # Strix (adversarial)
ANTHROPIC_API_KEY=...  # dossier/thesis/industry, IC synthesis, Night Vision, chat
OPENAI_API_KEY=...     # accounting, evidence audit, valuation, embeddings

# optional per-agent override, e.g.
NOCTUA_MODEL_STRIX=grok-4.1-fast
```

`/lab` shows key status, the routing table, and recent runs per model.

Note: the current `.env.local` was copied from `~/.env` but that key is **expired** — replace it before running investigations.

Draft research is generated from model knowledge, not live filings. The system enforces evidence discipline (anything time-sensitive must be classified `unverified` with reduced confidence) — human verification is required before capital is committed.

## Research Trace Template

Every meaningful research action — agent or human — should become a trace. The canonical shape (see `traces` table in `db/schema.ts`):

```json
{
  "researcher": "AccountingAgent | Analyst A",
  "ticker": "XYZ",
  "current_question": "Is revenue growth coming from real demand or temporary channel build?",
  "action_taken": "Analyzed 10-Q inventory trends against revenue",
  "source_type": "SEC filing",
  "information_seen": "Inventory grew faster than revenue for two consecutive quarters",
  "interpretation": "Possible demand weakness or channel stuffing",
  "signal_category": "accounting_red_flag",
  "confidence_change": -0.18,
  "next_action": "Compare inventory trend against management commentary and competitor filings",
  "reasoning_pattern": "When inventory diverges from revenue, validate demand quality before trusting growth story",
  "outcome": null,
  "label": null
}
```

`outcome` and `label` are filled in later by postmortems and human labeling — that is the Stage 3 dataset (strong_signal / weak_signal / false_positive / …) that eventually feeds fine-tuning. Orchestration first, training later.

## Roadmap (per blueprint)

- **Phase 1 (done)** — Research memory: dossiers, claims/evidence, thesis versioning, memo generation, Noctua Score.
- **Phase 2 (done)** — Agent bench: accounting, industry, catalyst, valuation, evidence-auditor agents; every run logged as structured traces in the Alpha Ledger. Vault with real EDGAR ingestion + grounded Q&A.
- **Phase 3 (done)** — Talons: portfolio + thesis-exposure tracking (theme exposure, not just ticker exposure), postmortems, trace labeling, JSONL export.
- **Phase 4 (done, on-demand)** — Night Vision: monitoring of new filings, price moves, catalysts, stale theses. Currently button/throttle-driven; a durable workflow engine like Temporal becomes relevant for true cron.
- **Phase 5** — Institutional layer: approvals, audit logs, role permissions, investor reporting.
- **Model Lab (live)** — routing and provider status today; once traces are labeled in volume: evaluation sets, preference training on "given the current research state, what should Noctua investigate next?"

The moat is not the model. It is the labeled decision-trace dataset this system accumulates.
