import { NextRequest } from "next/server";
import { lastScan, runNightVisionScan, SCAN_INTERVAL_MS, type ScanEvent } from "@/lib/nightvision";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let force = false;
  try {
    const body = (await req.json()) as { force?: boolean };
    force = Boolean(body?.force);
  } catch {
    // empty body — treat as a normal (throttled) scan request
  }

  const last = await lastScan();
  if (!force && last && Date.now() - last.getTime() < SCAN_INTERVAL_MS) {
    return Response.json({
      skipped: true,
      lastScanAt: last.toISOString(),
      message: "Night Vision ran within the last 10 minutes. Pass { force: true } to override.",
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: ScanEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        await runNightVisionScan(emit);
      } catch (err) {
        emit({
          stage: "error",
          message: err instanceof Error ? err.message : "Night Vision scan failed.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
  });
}
