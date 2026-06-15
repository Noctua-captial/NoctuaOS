"use client";

// Segment error boundary. Catches uncaught render errors in the app and offers
// a retry instead of crashing the whole tree. Next.js 16 passes `unstable_retry`
// (older versions used `reset`) — support both for forward/backward safety.
import { useEffect } from "react";

export default function Error({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  unstable_retry?: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const retry = unstable_retry ?? reset;

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="card max-w-md px-6 py-6 text-center">
        <div className="label !text-bear">Something broke</div>
        <p className="mt-2 text-sm text-parchment-dim">
          {error.message || "An unexpected error occurred in this view."}
        </p>
        {error.digest && (
          <p className="fin mt-1 text-[10px] text-parchment-faint">ref {error.digest}</p>
        )}
        {retry && (
          <button onClick={() => retry()} className="btn btn-primary mt-5 !text-[10px]">
            TRY AGAIN
          </button>
        )}
      </div>
    </div>
  );
}
