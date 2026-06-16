"use client";

// Augury pipeline controls for the overview. Two buttons sharing one status
// line, mirroring components/scan-button.tsx:
//   • "Poll for new tweets" → POST /api/augury/poll (JSON; enqueues ingest jobs)
//   • "Run pipeline"        → POST /api/augury/process (NDJSON progress stream)
// Both refresh the page data when they settle so the panels repaint.
import { useState } from "react";
import { useRouter } from "next/navigation";

type Busy = "poll" | "process" | null;
type ProcessLine = { stage: string; message?: string };

export function AuguryControls() {
  const router = useRouter();
  const [busy, setBusy] = useState<Busy>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function poll() {
    if (busy) return;
    setBusy("poll");
    setStatus("Polling sources for new posts…");
    try {
      const res = await fetch("/api/augury/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const body = (await res.json()) as { message?: string; enqueued?: number };
      setStatus(body.message ?? `Enqueued ${body.enqueued ?? 0} ingest job(s).`);
    } catch {
      setStatus("Poll failed — Augury unreachable.");
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  async function runPipeline() {
    if (busy) return;
    setBusy("process");
    setStatus("Starting pipeline…");
    try {
      const res = await fetch("/api/augury/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok || !res.body) {
        setStatus(`Pipeline failed (${res.status}).`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line) as ProcessLine;
            if (e.message) setStatus(e.message);
          } catch {
            // partial / malformed line — keep the last good status
          }
        }
      }
    } catch {
      setStatus("Pipeline failed — Augury unreachable.");
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  return (
    <div className="text-right">
      <div className="flex items-center gap-2.5">
        <button type="button" onClick={poll} disabled={busy !== null} className="btn">
          {busy === "poll" ? "POLLING…" : "POLL FOR NEW TWEETS"}
        </button>
        <button type="button" onClick={runPipeline} disabled={busy !== null} className="btn btn-primary">
          {busy === "process" ? "RUNNING…" : "RUN PIPELINE"}
        </button>
      </div>
      {status && (
        <div className="label mt-1.5 max-w-[340px] !text-[8.5px] leading-snug">{status}</div>
      )}
    </div>
  );
}
