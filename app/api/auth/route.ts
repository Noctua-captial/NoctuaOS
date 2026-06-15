import { NextRequest, NextResponse } from "next/server";
import { ACCESS_COOKIE, configuredToken, tokenValid } from "@/lib/auth";

// Sign in: exchange the shared access token for an httpOnly session cookie that
// the proxy gate checks. No-op when auth is disabled.
export async function POST(req: NextRequest) {
  if (!configuredToken()) return Response.json({ ok: true, authDisabled: true });

  const body = (await req.json().catch(() => ({}))) as { token?: unknown };
  const token = typeof body.token === "string" ? body.token : "";
  if (!tokenValid(token)) {
    return Response.json({ ok: false, error: "Invalid access token." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12, // 12h
  });
  return res;
}

// Sign out: clear the session cookie.
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(ACCESS_COOKIE);
  return res;
}
