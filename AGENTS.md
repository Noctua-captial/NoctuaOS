<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Cursor Cloud specific instructions

- Single Next.js 16 (App Router, Turbopack) app named `noctua-os`. Package manager: **npm**. Node 20+ (VM has Node 22). Standard scripts live in `package.json` (`dev`, `build`, `start`, `lint`); full setup is in `README.md`.
- The startup update script runs `npm install` only. The local SQLite DB (`noctua.db`) is gitignored and will NOT exist on a fresh VM, so before running the app you must initialize it once:
  - `npx drizzle-kit push` — creates the schema (idempotent; do not run interactively against destructive prompts).
  - `npx tsx db/seed.ts` — seeds example dossiers (TSEM, MU, AEHR, APLD, LEU). Override the DB location with `NOCTUA_DB_PATH`.
- Run the app with `npm run dev` (http://localhost:3000). Turbopack compiles each route lazily, so the **first request to `/` and to dynamic routes like `/dossiers/[ticker]` can take 10-20s**; later requests are fast. Don't mistake the slow first compile for a hang.
- AI features (the agent bench, Athena `/new`, Night Vision relevance, Vault embeddings, dossier chat) need provider keys (`XAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) in `.env.local` (copy from `.env.example`). With no keys the agent bench stays dormant, but all keyless features still work: market data/quotes, EDGAR filing ingest, Vault FTS search, dossiers, evidence/claims, positions/Talons, IC memos, War Room regime read.
- A benign React hydration-mismatch warning is logged for the dossier `ScoreWheel` SVG (computed arc values); it is pre-existing and not a failure.
