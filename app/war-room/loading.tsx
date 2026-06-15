// War Room computes regime + book quant across all open positions; stream a
// skeleton while those keyless-math + market calls resolve.
export default function Loading() {
  return (
    <div className="px-6 py-8 sm:px-10">
      <div className="h-3 w-32 animate-pulse bg-line" />
      <div className="mt-4 h-8 w-64 max-w-full animate-pulse bg-line" />
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="card h-20 animate-pulse" />
        ))}
      </div>
      <div className="mt-6 card h-80 animate-pulse" />
    </div>
  );
}
