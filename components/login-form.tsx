"use client";

import { useState } from "react";
import Link from "next/link";

function safeFrom(from: string): string {
  // Only allow same-app relative paths as the post-login destination.
  return from.startsWith("/") && !from.startsWith("//") ? from : "/";
}

export function LoginForm({ from, enabled }: { from: string; enabled: boolean }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!enabled) {
    return (
      <div className="card px-6 py-6 text-center">
        <p className="text-sm text-parchment-dim">
          Access control is disabled (no <span className="fin">NOCTUA_ACCESS_TOKEN</span> set).
        </p>
        <Link href="/" className="btn btn-primary mt-4 inline-block !text-[10px]">
          ENTER
        </Link>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(j?.error ?? `Sign-in failed (${res.status})`);
        setBusy(false);
        return;
      }
      window.location.href = safeFrom(from);
    } catch {
      setError("Sign-in failed. Try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card px-6 py-6">
      <label htmlFor="token" className="label mb-2 block">
        Access token
      </label>
      <input
        id="token"
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoFocus
        autoComplete="current-password"
        className="fin w-full border border-line-strong bg-ink px-4 py-3 text-sm tracking-[0.15em] text-parchment focus:border-platinum focus:outline-none"
      />
      {error && <p className="mt-3 text-[12px] text-bear">{error}</p>}
      <button
        type="submit"
        disabled={busy || token.length === 0}
        className="fin mt-5 w-full border border-line-strong px-4 py-3 text-xs tracking-[0.25em] text-parchment transition-colors hover:bg-ink-raised disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "VERIFYING…" : "UNLOCK"}
      </button>
    </form>
  );
}
