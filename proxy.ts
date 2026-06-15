// Request gate for Noctua OS (Next.js 16 "proxy", formerly middleware).
// Two protections run before any route renders:
//   1. Always-on rate limiting for /api/* — bounds abuse of the expensive,
//      unauthenticated LLM/scraping endpoints (Athena alone is ~30 model calls).
//   2. Opt-in access-token auth — when NOCTUA_ACCESS_TOKEN is set, every page
//      and API route (except sign-in/health) requires the token, so neither the
//      server-rendered research nor /api/export/traces is exposed publicly.
//
// State here (the rate-limit map) is per-instance; a multi-instance deployment
// should back it with a shared store (e.g. Redis). That matches the app's
// current single-instance model (local SQLite, in-process caches).
import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, bearerToken, configuredToken, tokenValid } from "@/lib/auth";

const WINDOW_MS = Number(process.env.NOCTUA_RATELIMIT_WINDOW_MS ?? 60_000);
const GENERAL_LIMIT = Number(process.env.NOCTUA_RATELIMIT_GENERAL ?? 120);
const EXPENSIVE_LIMIT = Number(process.env.NOCTUA_RATELIMIT_EXPENSIVE ?? 20);

// Compute/cost-heavy or data-exfiltration endpoints get the stricter bucket.
const EXPENSIVE_PREFIXES = [
  "/api/athena",
  "/api/oracle",
  "/api/nightvision",
  "/api/warroom",
  "/api/sizing",
  "/api/vault",
  "/api/postmortem",
  "/api/export",
];

// Reachable without a token so a locked-out user can authenticate / health-check.
const OPEN_PREFIXES = ["/login", "/api/auth", "/api/health"];

type Window = { count: number; resetAt: number };
const buckets = new Map<string, Window>();

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}

function hit(key: string, limit: number): { ok: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  // Opportunistic prune so the map can't grow without bound.
  if (buckets.size > 5_000) {
    for (const [k, w] of buckets) if (now >= w.resetAt) buckets.delete(k);
  }
  const w = buckets.get(key);
  if (!w || now >= w.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true, remaining: limit - 1, resetAt: now + WINDOW_MS };
  }
  if (w.count >= limit) return { ok: false, remaining: 0, resetAt: w.resetAt };
  w.count += 1;
  return { ok: true, remaining: limit - w.count, resetAt: w.resetAt };
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const isOpen = OPEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p));

  // 1) Rate limit API routes (always on, independent of auth).
  if (isApi) {
    const expensive = EXPENSIVE_PREFIXES.some((p) => pathname.startsWith(p));
    const limit = expensive ? EXPENSIVE_LIMIT : GENERAL_LIMIT;
    const rl = hit(`${clientIp(req)}:${expensive ? "exp" : "gen"}`, limit);
    if (!rl.ok) {
      const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
      return Response.json(
        { error: "Rate limit exceeded. Slow down." },
        { status: 429, headers: { "Retry-After": String(retryAfter), "X-RateLimit-Limit": String(limit) } },
      );
    }
  }

  // 2) Access-token auth (only when NOCTUA_ACCESS_TOKEN is configured).
  if (configuredToken() && !isOpen) {
    const provided =
      req.cookies.get(ACCESS_COOKIE)?.value ??
      bearerToken(req.headers.get("authorization")) ??
      req.headers.get("x-noctua-token");

    if (!tokenValid(provided)) {
      if (isApi) {
        return Response.json(
          { error: "Unauthorized — sign in or present the Noctua access token." },
          { status: 401 },
        );
      }
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      url.search = `?from=${encodeURIComponent(pathname)}`;
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  // Run on every route except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.svg$).*)"],
};
