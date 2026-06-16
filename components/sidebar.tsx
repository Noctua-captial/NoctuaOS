"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  { href: "/", code: "01", name: "The Perch", desc: "Command center" },
  { href: "/dossiers", code: "02", name: "Dossiers", desc: "Company research" },
  { href: "/vault", code: "03", name: "The Vault", desc: "Evidence & documents" },
  { href: "/ic", code: "04", name: "IC Chamber", desc: "Investment memos" },
  { href: "/talons", code: "05", name: "Talons", desc: "Active positions" },
  { href: "/war-room", code: "06", name: "War Room", desc: "Regime & navigation" },
  { href: "/ledger", code: "07", name: "Alpha Ledger", desc: "Traces & decisions" },
  { href: "/lab", code: "08", name: "Model Lab", desc: "Agents & routing" },
  { href: "/new", code: "09", name: "Athena", desc: "New investigation" },
  { href: "/augury", code: "10", name: "Augury", desc: "Trader intelligence" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 z-20 flex h-screen w-60 shrink-0 flex-col border-r border-line bg-ink-raised">
      <div className="border-b border-line px-6 py-7">
        <Link href="/" className="block">
          <div className="serif text-[26px] font-semibold tracking-wide text-parchment">
            NOCTUA
          </div>
          <div className="label mt-1.5">Decision Intelligence</div>
        </Link>
      </div>

      <div className="px-3 pt-4">
        <button
          onClick={() => window.dispatchEvent(new Event("noctua:command"))}
          className="flex w-full items-center gap-2.5 border border-line px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-ink-card"
        >
          <span className="serif text-sm text-parchment-faint">α</span>
          <span className="flex-1 text-[12px] text-parchment-faint">Command…</span>
          <kbd className="label border border-line px-1.5 py-0.5 !text-[8px]">⌘K</kbd>
        </button>
      </div>

      <nav className="flex-1 px-3 py-4">
        {nav.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`group mb-1 flex items-baseline gap-3 border px-3 py-2.5 transition-colors ${
                active
                  ? "border-line-strong bg-ink-card"
                  : "border-transparent hover:border-line hover:bg-ink-card/50"
              }`}
            >
              <span className="fin text-[10px] text-parchment-faint">{item.code}</span>
              <span>
                <span
                  className={`block text-[13px] tracking-wide ${
                    active ? "text-parchment" : "text-parchment-dim group-hover:text-parchment"
                  }`}
                >
                  {item.name}
                </span>
                <span className="label mt-0.5 block !text-[9px]">{item.desc}</span>
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-line px-6 py-5">
        <div className="label">Sees in the dark</div>
        <div className="fin mt-1 text-[10px] text-parchment-faint">v0.1 — internal</div>
      </div>
    </aside>
  );
}
