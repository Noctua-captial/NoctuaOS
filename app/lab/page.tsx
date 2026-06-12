import { desc } from "drizzle-orm";
import { db, tables } from "@/db";
import { PageHeader, TickerLink } from "@/components/ui";
import { AGENTS, ROUTING, getProviderStatus, overrideEnvVar, type Provider } from "@/lib/models";

export const dynamic = "force-dynamic";

const providerLabel: Record<Provider, string> = {
  xai: "xAI",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

export default async function Lab() {
  const status = getProviderStatus();
  const live = new Set(status.filter((s) => s.configured).map((s) => s.provider));

  const runRows = await db
    .select()
    .from(tables.agentRuns)
    .orderBy(desc(tables.agentRuns.createdAt))
    .limit(120);

  const byModel = new Map<string, typeof runRows>();
  for (const r of runRows) {
    const key = r.model ?? "unrecorded";
    const group = byModel.get(key);
    if (group) group.push(r);
    else byModel.set(key, [r]);
  }

  return (
    <div>
      <PageHeader
        kicker="Model Lab — Routing &amp; Provider Status"
        title="Which mind runs which desk"
      />

      <div className="grid grid-cols-12 gap-6 px-10 py-8">
        <section className="col-span-8">
          <div className="label mb-3">Agent Routing — preferred model, fallback chain, override</div>
          <div className="card divide-y divide-line">
            {AGENTS.map((agent) => {
              const chain = ROUTING[agent];
              const resolved = chain.find((r) => live.has(r.provider));
              return (
                <div key={agent} className="px-5 py-4">
                  <div className="flex items-baseline gap-3">
                    <span className="fin text-[11px] tracking-[0.1em] text-parchment">
                      {agent.replace(/_/g, " ").toUpperCase()}
                    </span>
                    <span className="fin text-[11px] text-platinum">{chain[0].modelId}</span>
                    <span className="fin text-[9px] uppercase tracking-[0.12em] text-parchment-faint">
                      {providerLabel[chain[0].provider]}
                    </span>
                    {resolved ? (
                      <span
                        className={`fin ml-auto border px-1.5 py-px text-[9px] uppercase tracking-[0.1em] ${
                          resolved === chain[0]
                            ? "border-bull/50 text-bull"
                            : "border-warn/50 text-warn"
                        }`}
                      >
                        {resolved === chain[0] ? "Routed" : `Fallback → ${resolved.modelId}`}
                      </span>
                    ) : (
                      <span className="fin ml-auto border border-bear/50 px-1.5 py-px text-[9px] uppercase tracking-[0.1em] text-bear">
                        No live provider
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-3 text-[10px]">
                    <span className="label !text-[9px]">Chain</span>
                    <span className="fin text-parchment-faint">
                      {chain.map((r) => r.modelId).join(" → ")}
                    </span>
                    <span className="label ml-auto !text-[9px]">Override</span>
                    <span className="fin text-parchment-faint">{overrideEnvVar(agent)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="col-span-4 space-y-6">
          <div>
            <div className="label mb-3">Provider Keys</div>
            <div className="card divide-y divide-line">
              {status.map((s) => (
                <div key={s.provider} className="flex items-center gap-3 px-4 py-3">
                  <span className="fin text-[11px] tracking-[0.1em] text-parchment">
                    {providerLabel[s.provider].toUpperCase()}
                  </span>
                  <span className="fin text-[10px] text-parchment-faint">{s.envVar}</span>
                  <span
                    className={`fin ml-auto border px-1.5 py-px text-[9px] uppercase tracking-[0.1em] ${
                      s.configured ? "border-bull/50 text-bull" : "border-bear/50 text-bear"
                    }`}
                  >
                    {s.configured ? "Configured" : "Missing"}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-parchment-faint">
              Keys are read from .env.local. A missing key routes each agent down its fallback
              chain; if no provider is configured, the agent bench stays dormant.
            </p>
          </div>

          <div>
            <div className="label mb-3">Recent Runs by Model — last {runRows.length}</div>
            <div className="space-y-3">
              {[...byModel.entries()].map(([model, runs]) => (
                <div key={model} className="card">
                  <div className="flex items-baseline justify-between px-4 py-2.5">
                    <span className="fin text-[11px] tracking-[0.1em] text-platinum">{model}</span>
                    <span className="fin text-[10px] text-parchment-faint">{runs.length} run(s)</span>
                  </div>
                  <div className="divide-y divide-line border-t border-line">
                    {runs.slice(0, 6).map((r) => (
                      <div key={r.id} className="flex items-baseline gap-2 px-4 py-2">
                        <span className="fin text-[10px] tracking-[0.1em] text-parchment">
                          {r.agent.replace(/_/g, " ").toUpperCase()}
                        </span>
                        <span className="fin ml-auto text-[9px] text-parchment-faint/70">
                          {r.createdAt?.toISOString().slice(0, 16).replace("T", " ")}
                        </span>
                        {r.ticker && <TickerLink ticker={r.ticker} />}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {byModel.size === 0 && (
                <div className="card px-5 py-10 text-center text-sm text-parchment-faint">
                  No agent runs logged. Run an Athena investigation — each run records the model
                  that actually produced it.
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
