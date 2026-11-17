import { KuublBucket } from "./KuublMark";

/** The Kuubl bucket mark on a dark rounded tile, drawn in the current accent colour. */
export default function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="7" fill="var(--bg-2)" />
      <g transform="translate(5 4.5) scale(0.69)">
        <KuublBucket />
      </g>
    </svg>
  );
}
