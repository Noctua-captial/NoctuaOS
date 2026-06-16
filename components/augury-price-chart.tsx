// Price-around-date visual for the Augury post deep-dive. Server-renderable
// inline SVG (same ethos as components/sparkline.tsx) that plots a window of
// adjusted closes and marks the post date with a vertical rule + dot, so you
// can see what the stock did right around when the call was made.
export interface PriceBar {
  date: string; // YYYY-MM-DD
  close: number;
}

export function AuguryPriceChart({
  bars,
  markerDate,
  width = 560,
  height = 160,
}: {
  bars: PriceBar[];
  markerDate: string; // YYYY-MM-DD of the post
  width?: number;
  height?: number;
}) {
  if (bars.length < 2) {
    return (
      <div className="flex h-[160px] items-center justify-center text-xs text-parchment-faint">
        Not enough price history around this date to chart.
      </div>
    );
  }

  const padX = 4;
  const padY = 10;
  const closes = bars.map((b) => b.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;

  const x = (i: number) => padX + (i / (bars.length - 1)) * (width - padX * 2);
  const y = (v: number) => padY + (1 - (v - min) / range) * (height - padY * 2);

  const points = bars.map((b, i) => `${x(i).toFixed(2)},${y(b.close).toFixed(2)}`).join(" ");

  // Marker index: last bar on/before the post date (no lookahead), else first bar.
  const d = markerDate.slice(0, 10);
  let markerIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date <= d) markerIdx = i;
    else break;
  }
  if (markerIdx < 0) markerIdx = 0;
  const markerX = x(markerIdx);
  const markerClose = bars[markerIdx].close;

  return (
    <div>
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        className="block"
      >
        {/* price path */}
        <polyline
          points={points}
          fill="none"
          stroke="var(--platinum)"
          strokeWidth="1.25"
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity="0.85"
        />
        {/* post-date marker */}
        <line
          x1={markerX}
          y1={padY}
          x2={markerX}
          y2={height - padY}
          stroke="var(--warn)"
          strokeWidth="1"
          strokeDasharray="3 3"
          opacity="0.8"
        />
        <circle cx={markerX} cy={y(markerClose)} r="3" fill="var(--warn)" />
      </svg>
      <div className="mt-1 flex items-center justify-between">
        <span className="fin text-[9px] text-parchment-faint">{bars[0].date}</span>
        <span className="fin text-[9px] text-warn">
          post · {d} · {markerClose.toFixed(2)}
        </span>
        <span className="fin text-[9px] text-parchment-faint">{bars[bars.length - 1].date}</span>
      </div>
      <div className="mt-0.5 flex items-center justify-between">
        <span className="fin text-[9px] text-parchment-faint">lo {min.toFixed(2)}</span>
        <span className="fin text-[9px] text-parchment-faint">hi {max.toFixed(2)}</span>
      </div>
    </div>
  );
}
