import { useEffect, useState } from "react";
import { useStore } from "../store";
import { tr } from "../i18n";
import { KuublBucket } from "./KuublMark";

/** Animated logo shown while the launcher loads its data; fades out once ready. */
export default function Splash() {
  const { ready } = useStore();
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const h = setTimeout(() => setGone(true), 450);
    return () => clearTimeout(h);
  }, [ready]);
  if (gone) return null;
  return (
    <div className={`splash ${ready ? "out" : ""}`} aria-busy={!ready} aria-label={tr("Načítám Kuubl Client", "Loading Kuubl Client")}>
      <div className="splash-inner">
        <div className="splash-logo">
          <svg width="96" height="96" viewBox="0 0 32 32" aria-hidden="true">
            <rect x="1" y="1" width="30" height="30" rx="7" fill="var(--bg-2)" />
            <g transform="translate(5 4.5) scale(0.69)">
              <KuublBucket className="j" />
            </g>
          </svg>
        </div>
        <div className="splash-title">
          Kuubl <b>Client</b>
        </div>
        <div className="splash-bar">
          <div />
        </div>
      </div>
    </div>
  );
}
