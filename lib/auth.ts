// Lightweight access control for the private terminal. Auth is OPT-IN: set
// NOCTUA_ACCESS_TOKEN to require a shared access token (presented as a cookie
// after sign-in, or as a Bearer / x-noctua-token header for programmatic use).
// With no token configured, the app is open (local-dev default) — but rate
// limiting in proxy.ts still applies.
import { timingSafeEqual } from "node:crypto";

export const ACCESS_COOKIE = "noctua_access";

/** The configured shared token, or null when auth is disabled. */
export function configuredToken(): string | null {
  const t = process.env.NOCTUA_ACCESS_TOKEN;
  return t && t.length > 0 ? t : null;
}

export function authEnabled(): boolean {
  return configuredToken() != null;
}

/** Constant-time check of a presented token against the configured one. When
 *  auth is disabled this is always true. */
export function tokenValid(provided: string | null | undefined): boolean {
  const expected = configuredToken();
  if (!expected) return true; // auth disabled
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull a bearer token out of an Authorization header. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}
