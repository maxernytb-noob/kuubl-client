// Global UI feedback sounds, delegated from the document so no component has to opt in: a soft tick
// when you press an interactive control, a subtler one the first time you hover it, a two-tone for a
// checkbox/radio. All gated by the sound preferences in sounds.ts (uiTick is a no-op when off).

import { uiTick } from "./sounds";

// The controls worth a tick. Kept to things that read as buttons/links/toggles so plain text and
// scroll areas stay silent.
const CLICKABLE = [
  "button",
  "[role=button]",
  "a[href]",
  ".btn",
  ".cape-pick",
  ".pill",
  ".nav-item",
  ".seg button",
  "input[type=checkbox]",
  "input[type=radio]",
  "label.lw-follow",
].join(",");

function interactive(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest(CLICKABLE) : null;
}

function isToggle(el: Element): boolean {
  if (el.matches("input[type=checkbox], input[type=radio]")) return true;
  const input = el.querySelector?.("input[type=checkbox], input[type=radio]");
  return !!input;
}

let lastHover: Element | null = null;

/** Wires the global listeners once, from the main app's boot (not the tiny logs window). */
export function initUiSounds() {
  document.addEventListener(
    "pointerdown",
    (e) => {
      if ((e as PointerEvent).button !== 0) return; // left press only
      const el = interactive(e.target);
      if (!el || (el as HTMLButtonElement).disabled) return;
      uiTick(isToggle(el) ? "toggle" : "click");
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "pointerover",
    (e) => {
      const el = interactive(e.target);
      if (!el || el === lastHover || (el as HTMLButtonElement).disabled) return;
      lastHover = el;
      uiTick("hover");
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "pointerout",
    (e) => {
      if (interactive(e.target) === lastHover) lastHover = null;
    },
    { passive: true, capture: true },
  );
}
