/** The Kuubl bucket (hand-drawn mark by Chlebas) in a 32x32 box; paths take their colour from CSS/props. */
export function KuublBucket({ color = "var(--red)", className }: { color?: string; className?: string }) {
  return (
    <g transform="rotate(-5 16 16)" className={className}>
      <path className="kb-body" pathLength={100} fill={color} stroke={color} strokeWidth="2" strokeLinejoin="round" d="M7.5 16.5L24.5 16L22.3 28.3L9.8 28.5Z" />
      <path className="kb-line" pathLength={100} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5.5 12.2C12 11.6 20 11.4 26.5 11.8" />
      <path className="kb-line" pathLength={100} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" d="M7.5 11C8 2.5 24 2 24.5 10.6" />
    </g>
  );
}

/** The hand-drawn lowercase "kuubl" wordmark, stroked in the current text colour. */
export function KuublWordmark({ height = 18 }: { height?: number }) {
  return (
    <svg height={height} width={(height * 96) / 40} viewBox="0 0 96 40" aria-label="kuubl" role="img">
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5">
        <path d="M4 5C4.6 14 3.6 25 4.5 34.5" />
        <path d="M17 15.5C13 19.5 9.5 22.5 6 26" />
        <path d="M9.5 23C12.5 27 15.5 31 18.5 34.5" />
        <path d="M27 16.5C26.6 21 26.5 24 27 27C27.6 32 30 34.5 33 34.5C37 34.5 39 31 39.2 26" />
        <path d="M39.5 16C39 22 39.4 28 40 34.5" />
        <path d="M48 16C47.5 21 47.6 24 48 27C48.6 32 51 34.5 54 34.5C58 34.5 60 31 60.3 26" />
        <path d="M60.5 16.5C60 22 60.6 28 61 34.5" />
        <path d="M69.5 4.5C70 14 69 25 69.8 34" />
        <path d="M70 25C70.5 18 75 15.8 78.5 16.2C83 16.8 85 21 84.6 25.5C84.2 30.5 81 34.4 77 34.2C73.5 34 70.5 31 70 26.5" />
        <path d="M92 4.5C91.4 14 92.4 24 91.8 34.5" />
      </g>
    </svg>
  );
}
