"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Company = { ticker: string; name: string; status: string; score: number | null; thesisStatus: string | null };
type Memo = { id: number; version: number; recommendation: string | null; ticker: string };

type Item = {
  id: string;
  group: "Actions" | "Companies" | "Memos" | "Navigate";
  title: string;
  sub?: string;
  hint?: string;
  href: string;
  accent?: string;
  /** Optional side effect run instead of plain navigation. */
  run?: () => void;
};

const NAV: Item[] = [
  { id: "nav-perch", group: "Navigate", title: "The Perch", sub: "Command center", href: "/", hint: "G P" },
  { id: "nav-dossiers", group: "Navigate", title: "Dossiers", sub: "Coverage universe", href: "/dossiers", hint: "G D" },
  { id: "nav-vault", group: "Navigate", title: "The Vault", sub: "Evidence & documents", href: "/vault", hint: "G V" },
  { id: "nav-ic", group: "Navigate", title: "IC Chamber", sub: "Investment memos", href: "/ic", hint: "G I" },
  { id: "nav-talons", group: "Navigate", title: "Talons", sub: "Active positions", href: "/talons", hint: "G T" },
  { id: "nav-warroom", group: "Navigate", title: "War Room", sub: "Regime, mandate & navigation", href: "/war-room", hint: "G W" },
  { id: "nav-ledger", group: "Navigate", title: "Alpha Ledger", sub: "Traces & decisions", href: "/ledger", hint: "G L" },
  { id: "nav-lab", group: "Navigate", title: "Model Lab", sub: "Agents & routing", href: "/lab", hint: "G M" },
  { id: "nav-athena", group: "Navigate", title: "Athena", sub: "New investigation", href: "/new", hint: "G A" },
];

// "G then <key>" quick-nav, matching the hints shown in the palette.
const GOTO: Record<string, string> = {
  p: "/",
  d: "/dossiers",
  v: "/vault",
  i: "/ic",
  t: "/talons",
  w: "/war-room",
  l: "/ledger",
  m: "/lab",
  a: "/new",
};

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

function score(text: string, q: string): number {
  const t = text.toLowerCase();
  const s = q.toLowerCase();
  if (!s) return 0.4;
  if (t === s) return 3;
  if (t.startsWith(s)) return 2;
  if (t.includes(s)) return 1;
  // loose subsequence
  let i = 0;
  for (const ch of t) if (ch === s[i]) i++;
  return i === s.length ? 0.5 : -1;
}

export function CommandBar() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [data, setData] = useState<{ companies: Company[]; memos: Memo[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const gPendingRef = useRef(0);

  const openBar = useCallback(() => {
    setOpen(true);
    setQ("");
    setSel(0);
    if (!data) {
      fetch("/api/command")
        .then((r) => r.json())
        .then(setData)
        .catch(() => {});
    }
  }, [data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => {
          if (!o) openBar();
          return !o;
        });
        return;
      }
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      // "G then <key>" quick navigation — only when not typing and no modifiers.
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(document.activeElement)) return;
      const key = e.key.toLowerCase();
      if (key === "g") {
        gPendingRef.current = Date.now();
        return;
      }
      if (gPendingRef.current && Date.now() - gPendingRef.current < 1500 && GOTO[key]) {
        gPendingRef.current = 0;
        router.push(GOTO[key]);
      } else {
        gPendingRef.current = 0;
      }
    };
    window.addEventListener("keydown", onKey);
    const onOpen = () => openBar();
    window.addEventListener("noctua:command", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("noctua:command", onOpen);
    };
  }, [openBar, router]);

  // Keep keyboard focus inside the dialog while it is open.
  function trapFocus(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'input, button, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const query = q.trim();
    const tickerLike = /^[A-Za-z.\-]{1,8}$/.test(query) && query.length >= 1;

    const ql = query.toLowerCase();
    if (!query || "scan night vision".includes(ql) || "night vision scan".includes(ql)) {
      out.push({
        id: "act-nightvision",
        group: "Actions",
        title: "Scan Night Vision",
        sub: "Sweep coverage — new filings, price moves, catalysts",
        href: "/",
        accent: "var(--warn)",
        run: () => {
          // Fire the forced scan; draining the body lets the sweep run to completion.
          fetch("/api/nightvision/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force: true }),
          })
            .then((r) => r.text())
            .catch(() => {});
          router.push("/");
        },
      });
    }

    if (!query || "convene the council".includes(ql) || "war room council brief".includes(ql)) {
      out.push({
        id: "act-council",
        group: "Actions",
        title: "Convene the council",
        sub: "War Room — PM, Risk, and Strix produce a navigation brief",
        href: "/war-room",
        accent: "var(--platinum)",
        run: () => {
          fetch("/api/warroom/brief", { method: "POST" }).catch(() => {});
          router.push("/war-room");
        },
      });
    }

    if (tickerLike && query.length >= 2) {
      out.push({
        id: "act-investigate",
        group: "Actions",
        title: `Investigate ${query.toUpperCase()} with Athena`,
        sub: "Full agent bench → IC memo",
        href: `/new?ticker=${query.toUpperCase()}`,
        accent: "var(--parchment)",
      });
      out.push({
        id: "act-ingest",
        group: "Actions",
        title: `Pull ${query.toUpperCase()} filings into the Vault`,
        sub: "SEC EDGAR — primary sources",
        href: `/vault?ticker=${query.toUpperCase()}`,
        accent: "var(--platinum)",
      });
    }

    const scoredCompanies = (data?.companies ?? [])
      .map((c) => ({ c, s: Math.max(score(c.ticker, query), score(c.name, query)) }))
      .filter(({ s }) => s >= 0)
      .sort((a, b) => b.s - a.s);
    for (const { c } of scoredCompanies) {
      out.push({
        id: `co-${c.ticker}`,
        group: "Companies",
        title: c.ticker,
        sub: `${c.name} · ${c.status}${c.score != null ? ` · ${c.score}` : ""}`,
        href: `/dossiers/${c.ticker}`,
        accent:
          c.thesisStatus === "broken"
            ? "var(--bear)"
            : c.thesisStatus === "weakening"
              ? "var(--warn)"
              : c.thesisStatus === "strengthening"
                ? "var(--bull)"
                : "var(--platinum)",
      });
    }

    for (const m of data?.memos ?? []) {
      const s = score(`${m.ticker} memo`, query);
      if (s < 0 || (!query && out.length > 14)) continue;
      out.push({
        id: `memo-${m.id}`,
        group: "Memos",
        title: `${m.ticker} — Memo v${m.version}`,
        sub: m.recommendation === "more_work" ? "more work needed" : (m.recommendation ?? ""),
        href: `/ic/${m.id}`,
      });
    }

    for (const n of NAV) {
      const s = Math.max(score(n.title, query), score(n.sub ?? "", query));
      if (s < 0) continue;
      out.push(n);
    }

    // sort within insertion order by group priority, then trim
    const groupOrder = { Actions: 0, Companies: 1, Memos: 2, Navigate: 3 };
    return out
      .sort((a, b) => groupOrder[a.group] - groupOrder[b.group])
      .slice(0, query ? 12 : 14);
  }, [q, data, router]);

  // reset selection when the query changes (render-time adjustment, not an effect)
  const [prevQ, setPrevQ] = useState(q);
  if (q !== prevQ) {
    setPrevQ(q);
    setSel(0);
  }

  function go(item: Item) {
    setOpen(false);
    if (item.run) {
      item.run();
      return;
    }
    router.push(item.href);
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && items[sel]) {
      go(items[sel]);
    }
  }

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const groupStarts = new Set<number>();
  {
    let g = "";
    items.forEach((item, i) => {
      if (item.group !== g) {
        groupStarts.add(i);
        g = item.group;
      }
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[14vh] backdrop-blur-[2px]"
      onClick={() => setOpen(false)}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="fade-up w-[620px] max-w-[calc(100vw-1.5rem)] border border-line-strong bg-ink-raised shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapFocus}
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <span className="serif text-xl text-parchment-faint">α</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Ticker, company, memo, or command…"
            className="fin flex-1 bg-transparent text-[15px] text-parchment placeholder:text-parchment-faint/60 focus:outline-none"
          />
          <kbd className="label border border-line px-1.5 py-0.5 !text-[8px]">ESC</kbd>
        </div>

        <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-2">
          {items.map((item, i) => {
            const showGroup = groupStarts.has(i);
            return (
              <div key={item.id}>
                {showGroup && <div className="label px-5 pb-1 pt-3 !text-[8px]">{item.group}</div>}
                <button
                  data-idx={i}
                  onClick={() => go(item)}
                  onMouseEnter={() => setSel(i)}
                  className={`flex w-full items-center gap-3 px-5 py-2.5 text-left ${
                    sel === i ? "bg-ink-card" : ""
                  }`}
                >
                  <span
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: item.accent ?? "var(--platinum-line-strong)" }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-parchment">{item.title}</span>
                    {item.sub && (
                      <span className="block truncate text-[10.5px] text-parchment-faint">{item.sub}</span>
                    )}
                  </span>
                  {sel === i && <span className="label !text-[8px]">↵</span>}
                </button>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-parchment-faint">
              Nothing matches. Try a ticker — Athena can open a new investigation.
            </div>
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-line px-5 py-2.5">
          <span className="label !text-[8px]">↑↓ navigate</span>
          <span className="label !text-[8px]">↵ open</span>
          <span className="label ml-auto !text-[8px]">Noctua sees in the dark</span>
        </div>
      </div>
    </div>
  );
}
