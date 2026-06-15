"use client";

// Resolves a Perch alert via the server action and surfaces the result as a
// toast (the action previously ran from an inline form with no feedback).
import { useTransition } from "react";
import { resolveAlert } from "@/app/actions";
import { useToast } from "@/components/toast";

export function ResolveAlertButton({ id }: { id: number }) {
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            const result = await resolveAlert(id);
            toast(result.message, result.ok ? "success" : "error");
          } catch {
            toast("Could not resolve the alert. Try again.", "error");
          }
        })
      }
      className="label !text-[9px] opacity-50 transition-opacity hover:opacity-100 disabled:opacity-30"
      title="Resolve — remove from queue"
    >
      {pending ? "RESOLVING…" : "RESOLVE ✕"}
    </button>
  );
}
