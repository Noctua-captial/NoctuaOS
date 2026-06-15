// Dossier detail is the heaviest route (~15 queries + quant/oracle/GARCH); show
// a structured skeleton while it streams instead of blocking on a blank page.
export default function Loading() {
  return (
    <div>
      <div className="border-b border-line px-6 py-7 sm:px-10">
        <div className="h-3 w-24 animate-pulse bg-line" />
        <div className="mt-3 h-9 w-64 max-w-full animate-pulse bg-line" />
        <div className="mt-3 h-3 w-96 max-w-full animate-pulse bg-line" />
      </div>
      <div className="grid grid-cols-1 gap-6 px-6 py-8 sm:px-10 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-8">
          <div className="card h-40 animate-pulse" />
          <div className="card h-64 animate-pulse" />
        </div>
        <div className="space-y-4 lg:col-span-4">
          <div className="card h-48 animate-pulse" />
          <div className="card h-32 animate-pulse" />
        </div>
      </div>
    </div>
  );
}
