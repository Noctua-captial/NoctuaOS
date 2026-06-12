"use client";

import { useTransition } from "react";
import { updateCompanyStatus, updateThesisStatus } from "@/app/actions";

const COMPANY_STATUS = ["pipeline", "watchlist", "active", "rejected", "exited"];
const THESIS_STATUS = ["strengthening", "stable", "weakening", "broken"];

export function StatusControls({
  companyId,
  status,
  thesisStatus,
}: {
  companyId: number;
  status: string;
  thesisStatus: string | null;
}) {
  const [pending, start] = useTransition();

  const selectCls =
    "fin cursor-pointer border border-line bg-ink px-2.5 py-1.5 text-[10px] uppercase tracking-[0.12em] text-parchment-dim transition-colors hover:border-line-strong focus:border-platinum focus:outline-none disabled:opacity-50";

  return (
    <div className={`flex items-center gap-2.5 ${pending ? "opacity-60" : ""}`}>
      <label className="label !text-[8px]">Status</label>
      <select
        value={status}
        disabled={pending}
        onChange={(e) => start(() => updateCompanyStatus(companyId, e.target.value))}
        className={selectCls}
      >
        {COMPANY_STATUS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <label className="label ml-2 !text-[8px]">Thesis</label>
      <select
        value={thesisStatus ?? "stable"}
        disabled={pending}
        onChange={(e) => start(() => updateThesisStatus(companyId, e.target.value))}
        className={selectCls}
      >
        {THESIS_STATUS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </div>
  );
}
