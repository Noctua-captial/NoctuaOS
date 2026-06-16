import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Lightweight access gate for the deployed app.
//
// Next.js 16 renamed the `middleware` file convention to `proxy` (the function
// is `proxy`, it runs on the Node.js runtime, and the runtime is not
// configurable). This file is the access-protection layer referenced by the
// migration plan as "middleware". See node_modules/next/dist/docs/01-app/
// 03-api-reference/03-file-conventions/proxy.md.
//
// Behavior:
//   - NO-OP unless AUGURY_ACCESS_PASSWORD is set, so local dev is never gated.
//   - Static assets / Next internals are excluded via the matcher below.
//   - Vercel Cron requests are always allowed (so scheduled jobs never break).
//   - Everything else requires either a matching access cookie or HTTP Basic
//     auth whose password equals AUGURY_ACCESS_PASSWORD.
//
// This is a deliberately simple gate, not a full auth system: on successful
// Basic auth we set an httpOnly cookie holding the shared password so the
// browser is not re-prompted on every request.

const ACCESS_COOKIE = "augury_access";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// Vercel attaches `x-vercel-cron` to scheduled invocations and, when
// CRON_SECRET is configured, also sends `Authorization: Bearer <CRON_SECRET>`.
function isVercelCron(request: NextRequest): boolean {
  if (request.headers.get("x-vercel-cron")) return true;

  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) {
    return true;
  }
  return false;
}

// Parse `Authorization: Basic base64(user:pass)` and compare the password part.
function hasValidBasicAuth(request: NextRequest, password: string): boolean {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Basic ")) return false;

  try {
    const decoded = atob(header.slice("Basic ".length).trim());
    const sep = decoded.indexOf(":");
    const pass = sep === -1 ? decoded : decoded.slice(sep + 1);
    return pass === password;
  } catch {
    return false;
  }
}

export function proxy(request: NextRequest) {
  const password = process.env.AUGURY_ACCESS_PASSWORD;

  // Gate disabled: no password configured (default for local dev).
  if (!password) return NextResponse.next();

  // Never block scheduled cron jobs.
  if (isVercelCron(request)) return NextResponse.next();

  // Already authenticated via the access cookie.
  if (request.cookies.get(ACCESS_COOKIE)?.value === password) {
    return NextResponse.next();
  }

  // Accept HTTP Basic auth and persist a cookie so we don't re-prompt.
  if (hasValidBasicAuth(request, password)) {
    const response = NextResponse.next();
    response.cookies.set(ACCESS_COOKIE, password, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });
    return response;
  }

  // Otherwise, challenge the browser with HTTP Basic auth.
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="noctua-os", charset="UTF-8"',
    },
  });
}

export const config = {
  // Run on every route EXCEPT Next internals and static assets. API routes are
  // intentionally included so they're gated too; cron requests are allowed
  // above via header checks.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
