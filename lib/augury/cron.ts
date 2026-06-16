import type { NextRequest } from "next/server";

/**
 * Authorize a scheduled (Vercel Cron) or manual GET against `CRON_SECRET`.
 *
 * When `CRON_SECRET` is set in the project env, Vercel automatically attaches
 * `Authorization: Bearer <CRON_SECRET>` to every cron invocation. We require a
 * matching secret and deny when it is unset, so the scheduled endpoints are
 * never world-open (the manual UI triggers use POST and are unaffected).
 */
export function authorizeCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
