import { NextRequest } from "next/server";
import { checkModelHealth, getProviderStatus } from "@/lib/models";

export const maxDuration = 60;

// Live probe of every configured provider/model. Validates that the model IDs
// in lib/models.ts actually resolve at the provider, rather than only checking
// for the presence of an API key. Results are cached briefly in-process.
export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";
  const providers = getProviderStatus();

  // Nothing to probe without a key — return early so the call is free and fast.
  if (!providers.some((p) => p.configured)) {
    return Response.json({
      checkedAt: new Date().toISOString(),
      anyConfigured: false,
      providers,
      models: [],
    });
  }

  const models = await checkModelHealth(force);
  return Response.json({
    checkedAt: new Date().toISOString(),
    anyConfigured: true,
    providers,
    models,
  });
}
