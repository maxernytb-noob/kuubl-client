import { useEffect, useState } from "react";

/**
 * Sidebar tooltips. The icon rail clips anything that sticks out (it scrolls, so overflow is hidden),
 * which cut the labels off; this draws the hovered button's `.tip` text in a fixed layer instead.
 */
export default function NavTip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const over = (e: PointerEvent) => {
      const b = (e.target as Element | null)?.closest?.(".sidebar:not(.wide) .navbtn, .sidebar:not(.wide) .sc, .sidebar:not(.wide) .logo-btn");
      const text = b?.querySelector(".tip")?.textContent;
      if (!b || !text) return setTip(null);
      const r = b.getBoundingClientRect();
      setTip({ text, x: r.right + 10, y: r.top + r.height / 2 });
    };
    const hide = () => setTip(null);
    document.addEventListener("pointerover", over, { passive: true });
    document.addEventListener("scroll", hide, { capture: true, passive: true });
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("scroll", hide, { capture: true });
      window.removeEventListener("blur", hide);
    };
  }, []);
  return tip ? <div className="nav-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div> : null;
}
