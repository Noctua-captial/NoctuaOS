// Route-level instant loading state. Shown while an async Server Component route
// (the Perch, dossiers, etc.) streams in, instead of a blank page.
export default function Loading() {
  return (
    <div className="px-6 py-8 sm:px-10">
      <div className="h-3 w-40 animate-pulse bg-line" />
      <div className="mt-4 h-8 w-72 max-w-full animate-pulse bg-line" />
      <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="card h-32 animate-pulse" />
        ))}
      </div>
      <div className="mt-4 card h-64 animate-pulse" />
    </div>
  );
}
