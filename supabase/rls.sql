-- Row Level Security: deny-all lockdown for every application table.
--
-- noctua-os talks to Postgres exclusively through the server-side connection
-- (the `postgres` role in DATABASE_URL / DIRECT_URL), which BYPASSES RLS. So
-- enabling RLS here does NOT affect the app's own queries.
--
-- What it does do:
--   * Enabling RLS with NO policies = deny-all for Supabase's auto-exposed
--     PostgREST roles (`anon` / `authenticated`). This closes the public
--     REST/GraphQL surface on these tables so they can't be read or written
--     over the Data API by an external client.
--   * Clears the Supabase "RLS disabled in public" security advisors.
--
-- We intentionally add NO policies: there is no end-user-scoped access pattern;
-- all access is server-side. If a public read path is ever needed, add explicit
-- policies per table.
--
-- Apply in the final verify phase, e.g.:
--   psql "$DIRECT_URL" -f supabase/rls.sql
--   (or paste into the Supabase SQL Editor, or run via the Supabase MCP).

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.theses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalysts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fundamentals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.postmortems ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quant_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.debates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.debate_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.council_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.news_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.directives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticker_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_bars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intraday_bars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backtests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.author_scorecards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
