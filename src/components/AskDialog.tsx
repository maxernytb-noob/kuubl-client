import { useEffect, useRef, useState } from "react";
import { tr } from "../i18n";

/** A text question in the launcher's own modal (replaces the browser's prompt()). */
type Ask = { title: string; label?: string; initial?: string; placeholder?: string; ok?: string; multiline?: boolean; confirm?: boolean; danger?: boolean; resolve: (v: string | null) => void };

let show: ((a: Ask) => void) | null = null;

/** Asks for a line of text; resolves to the trimmed text, or null when cancelled or left empty. */
export function askText(o: Omit<Ask, "resolve">): Promise<string | null> {
  return new Promise((resolve) => {
    if (!show) return resolve(null);
    show({ ...o, resolve });
  });
}

/** Asks a yes/no question in the launcher's own modal (replaces confirm()). */
export async function askConfirm(title: string, label?: string, ok?: string, danger = false): Promise<boolean> {
  return (await askText({ title, label, ok, confirm: true, danger, initial: "ok" })) !== null;
}

/** Mounted once in App; renders the current question. */
export default function AskDialog() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    show = (a) => {
      setValue(a.initial ?? "");
      setAsk(a);
    };
    return () => {
      show = null;
    };
  }, []);
  useEffect(() => {
    if (ask && !ask.confirm) setTimeout(() => input.current?.select(), 0);
  }, [ask]);

  if (!ask) return null;
  const done = (v: string | null) => {
    ask.resolve(v && v.trim() ? v.trim() : null);
    setAsk(null);
  };
  const keys = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "BUTTON" && e.key === "Enter") return;
    if (e.key === "Escape") done(null);
    if (e.key === "Enter" && (!ask.multiline || e.ctrlKey)) {
      e.preventDefault();
      done(value);
    }
  };

  return (
    <div className="overlay" onKeyDown={keys} onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <div className="modal" style={{ width: "min(440px, 100%)" }} role="dialog" aria-modal="true" aria-label={ask.title}>
        <div className="modal-head">
          <h2>{ask.title}</h2>
        </div>
        <div className="modal-body col" style={{ gap: 8 }}>
          {ask.label && <span className="muted small">{ask.label}</span>}
          {ask.confirm ? null : ask.multiline ? (
            <textarea ref={input} className="input" rows={3} value={value} placeholder={ask.placeholder} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <input ref={input} className="input" value={value} placeholder={ask.placeholder} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={() => done(null)}>{tr("Zrušit", "Cancel")}</button>
          <button className={`btn primary${ask.danger ? " danger" : ""}`} onClick={() => done(value)} disabled={!value.trim()} autoFocus={ask.confirm}>{ask.ok ?? "OK"}</button>
        </div>
      </div>
    </div>
  );
}
