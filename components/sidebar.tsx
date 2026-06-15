"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

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
];

export function Sidebar({ authEnabled = false }: { authEnabled?: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  async function lock() {
    await fetch("/api/auth", { method: "DELETE" }).catch(() => {});
    window.location.href = "/login";
  }

  return (
    <>
      {/* Mobile menu toggle — hidden once the rail is permanent at lg. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        className="fixed left-3 top-3 z-50 flex h-9 w-9 items-center justify-center border border-line bg-ink-raised text-parchment lg:hidden"
      >
        <span className="text-lg leading-none">{open ? "\u2715" : "\u2630"}</span>
      </button>

      {/* Backdrop behind the drawer on mobile. */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex h-screen w-60 shrink-0 flex-col border-r border-line bg-ink-raised transition-transform duration-200 lg:sticky lg:top-0 lg:z-20 lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="border-b border-line px-6 py-7">
          <Link href="/" className="block" onClick={close}>
            <div className="serif text-[26px] font-semibold tracking-wide text-parchment">
              NOCTUA
            </div>
            <div className="label mt-1.5">Decision Intelligence</div>
          </Link>
        </div>

      <div className="px-3 pt-4">
        <button
          onClick={() => {
            close();
            window.dispatchEvent(new Event("noctua:command"));
          }}
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
              onClick={close}
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
        <div className="flex items-center justify-between">
          <div>
            <div className="label">Sees in the dark</div>
            <div className="fin mt-1 text-[10px] text-parchment-faint">v0.1 — internal</div>
          </div>
          {authEnabled && (
            <button
              onClick={lock}
              className="label !text-[9px] text-parchment-faint transition-colors hover:text-parchment"
              title="Sign out — clears the access session"
            >
              LOCK ⏻
            </button>
          )}
        </div>
      </div>
      </aside>
    </>
  );
}
