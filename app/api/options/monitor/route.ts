import { NextRequest } from "next/server";
import { runOptionsMonitor, type OptionsMonitorEvent } from "@/lib/options/monitor";
import { authorizeCron } from "@/lib/augury/cron";

export const maxDuration = 120;

// GET — scheduled sweep (Vercel Cron, authorized by CRON_SECRET). This is the
// durable, cron-driven path: the options book is monitored on a schedule, not
// only when someone clicks Night Vision. (Could equally be enqueued on the
// jobs table; a cron hit keeps it decoupled from the Augury pipeline.)
export async function GET(req: NextRequest) {
  if (!authorizeCron(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { alertsRaised } = await runOptionsMonitor();
  return Response.json({ alertsRaised });
}

// POST — manual trigger from the UI, streamed.
export async function POST() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: OptionsMonitorEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        await runOptionsMonitor(emit);
      } catch (err) {
        emit({ stage: "error", message: err instanceof Error ? err.message : "Options monitor failed." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
  });
}
