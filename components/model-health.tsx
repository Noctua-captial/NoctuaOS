"use client";

import { useCallback, useEffect, useState } from "react";

type ModelHealth = {
  provider: string;
  modelId: string;
  kind: "language" | "embedding";
  ok: boolean;
  latencyMs: number;
  error?: string;
};

type HealthResp = {
  checkedAt: string;
  anyConfigured: boolean;
  models: ModelHealth[];
};

// Pure fetch — no setState, so it can be awaited inside the mount effect without
// tripping react-hooks/set-state-in-effect.
async function fetchHealth(force: boolean): Promise<HealthResp> {
  const res = await fetch(`/api/health/models${force ? "?force=1" : ""}`);
  if (!res.ok) throw new Error(`Probe failed (${res.status})`);
  return (await res.json()) as HealthResp;
}

export function ModelHealthPanel() {
  const [data, setData] = useState<HealthResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const recheck = useCallback(() => {
    setLoading(true);
    fetchHealth(true)
      .then((d) => {
        setData(d);
        setErr(null);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Probe failed"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const d = await fetchHealth(false);
        if (active) {
          setData(d);
          setErr(null);
        }
      } catch (e) {
        if (active) setErr(e instanceof Error ? e.message : "Probe failed");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="label">Live Model Health — provider reachability</span>
        <button
          type="button"
          onClick={recheck}
          disabled={loading}
          className="label !text-[9px] text-platinum transition-opacity hover:opacity-100 disabled:opacity-40"
          title="Re-probe each configured model with a 1-token call"
        >
          {loading ? "PROBING…" : "RE-CHECK ↻"}
        </button>
      </div>

      <div className="card">
        {err && (
          <div className="px-4 py-3 text-[11px] text-bear">{err}</div>
        )}

        {!err && data && !data.anyConfigured && (
          <div className="px-4 py-4 text-[11px] leading-relaxed text-parchment-faint">
            No provider key configured — nothing to probe. Add a key in
            <span className="fin"> .env.local</span> and re-check.
          </div>
        )}

        {!err && data && data.anyConfigured && data.models.length === 0 && (
          <div className="px-4 py-4 text-[11px] text-parchment-faint">No models resolved to probe.</div>
        )}

        {!err && data && data.models.length > 0 && (
          <div className="divide-y divide-line">
            {data.models.map((m) => (
              <div key={`${m.provider}:${m.modelId}:${m.kind}`} className="px-4 py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="fin text-[11px] tracking-[0.08em] text-platinum">{m.modelId}</span>
                  {m.kind === "embedding" && (
                    <span className="label !text-[8px] text-parchment-faint">EMBED</span>
                  )}
                  <span
                    className={`fin ml-auto border px-1.5 py-px text-[9px] uppercase tracking-[0.1em] ${
                      m.ok ? "border-bull/50 text-bull" : "border-bear/50 text-bear"
                    }`}
                  >
                    {m.ok ? `OK · ${m.latencyMs}ms` : "Unreachable"}
                  </span>
                </div>
                {!m.ok && m.error && (
                  <div className="mt-1 text-[10px] leading-snug text-bear/80">{m.error}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {!data && !err && (
          <div className="px-4 py-4 text-[11px] text-parchment-faint">Probing configured providers…</div>
        )}
      </div>
      {data && (
        <p className="mt-2 text-[10px] text-parchment-faint/70">
          Checked {new Date(data.checkedAt).toLocaleTimeString()}. Each probe is a 1-token call; results
          cache for ~60s.
        </p>
      )}
    </div>
  );
}
