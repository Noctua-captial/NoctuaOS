"use client";

// Semantic-memory search affordance — "everything they ever said about X".
// Pushes a `?q=` searchParam; the server page reads it and runs `searchPosts`
// (pgvector semantic, keyword fallback). Styled like the Vault's Ask box.
import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";

export function AugurySearchBox({
  initialQuery = "",
  placeholder = "everything they ever said about… (ticker, company, theme, macro)",
}: {
  initialQuery?: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState(initialQuery);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = q.trim();
    router.push(v ? `${pathname}?q=${encodeURIComponent(v)}` : pathname);
  }

  function clear() {
    setQ("");
    router.push(pathname);
  }

  return (
    <form onSubmit={submit} className="flex gap-3">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className="flex-1 border border-line-strong bg-ink px-3 py-2.5 text-sm text-parchment placeholder:text-parchment-faint/50 focus:border-platinum focus:outline-none"
      />
      {initialQuery && (
        <button
          type="button"
          onClick={clear}
          className="fin border border-line px-4 text-xs tracking-[0.2em] text-parchment-faint hover:bg-ink-raised hover:text-parchment-dim"
        >
          CLEAR
        </button>
      )}
      <button
        type="submit"
        disabled={!q.trim()}
        className="fin border border-line-strong px-5 text-xs tracking-[0.2em] text-parchment hover:bg-ink-raised disabled:cursor-not-allowed disabled:opacity-40"
      >
        SEARCH
      </button>
    </form>
  );
}
