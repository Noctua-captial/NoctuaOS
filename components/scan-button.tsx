"use client";

// Night Vision scan trigger for the Perch. Streams the NDJSON progress feed
// from /api/nightvision/scan and surfaces the latest event as transient
// status text, then refreshes the page data when the sweep completes.
import { useState } from "react";
import { useRouter } from "next/navigation";

type ScanEvent = { stage: string; message: string; ticker?: string };

export function ScanButton({ lastScanAt }: { lastScanAt: string | null }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function scan() {
    if (running) return;
    setRunning(true);
    setStatus("Contacting Night Vision…");
    try {
      const res = await fetch("/api/nightvision/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        // Throttled path — the route declined to run.
        const body = (await res.json()) as { message?: string };
        setStatus(body.message ?? "Scan skipped.");
        return;
      }
      if (!res.ok || !res.body) {
        setStatus(`Scan failed (${res.status}).`);
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
            const e = JSON.parse(line) as ScanEvent;
            setStatus(e.message);
          } catch {
            // partial / malformed line — keep the last good status
          }
        }
      }
      router.refresh();
    } catch {
      setStatus("Scan failed — Night Vision unreachable.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="text-right">
      <button type="button" onClick={scan} disabled={running} className="btn disabled:opacity-50">
        {running ? "SCANNING…" : "NIGHT VISION SCAN"}
      </button>
      <div className="label mt-1.5 max-w-[260px] !text-[8.5px] leading-snug">
        {status ??
          (lastScanAt
            ? `Last sweep ${new Date(lastScanAt).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}`
            : "No sweep on record")}
      </div>
    </div>
  );
}
