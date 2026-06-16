import { NextRequest } from "next/server";
import { runOptionsBacktests } from "@/lib/options/backtest";
import { authorizeCron } from "@/lib/augury/cron";

export const maxDuration = 120;

// GET — scheduled/cron-authorized rebuild of the backtest points + scorecards.
export async function GET(req: NextRequest) {
  if (!authorizeCron(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await runOptionsBacktests());
}

// POST — manual rebuild (e.g. after closing a structure).
export async function POST() {
  return Response.json(await runOptionsBacktests());
}
