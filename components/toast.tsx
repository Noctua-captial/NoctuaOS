"use client";

// Minimal toast/feedback layer. Mutations (server actions + client fetches)
// previously completed silently; useToast() gives every interactive surface a
// consistent way to confirm success or surface an error.
import { createContext, useCallback, useContext, useRef, useState } from "react";

type ToastKind = "success" | "error" | "info";
type Toast = { id: number; kind: ToastKind; message: string };

type ToastApi = { toast: (message: string, kind?: ToastKind) => void };

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  // No-op outside a provider so components stay usable in isolation/tests.
  return useContext(ToastContext) ?? { toast: () => {} };
}

const KIND_STYLES: Record<ToastKind, string> = {
  success: "border-l-bull",
  error: "border-l-bear",
  info: "border-l-platinum",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const toast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
  }, []);

  const dismiss = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="pointer-events-none fixed bottom-5 right-5 z-[70] flex w-[340px] max-w-[calc(100vw-2.5rem)] flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => dismiss(t.id)}
            className={`fade-up pointer-events-auto card border-l-2 px-4 py-3 text-left text-[12px] leading-snug text-parchment shadow-2xl ${KIND_STYLES[t.kind]}`}
          >
            {t.message}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
