// Short UI sounds, synthesized with Web Audio (nothing to download). Only for moments that matter:
// starting the game, something finishing, the game crashing, a friend writing, an achievement.
// Not on every click or toggle.

export type UiSound = "launch" | "done" | "error" | "notify" | "achievement" | "open";

let enabled = true;
let volume = 0.5;
let clicks = true;
let ctx: AudioContext | null = null;
let pack = "soft";
const custom: Record<"click" | "hover", string> = { click: "", hover: "" };
const decoded = new Map<string, AudioBuffer | null>();

/** Called by applyUi whenever the preferences change. */
export function setSoundPrefs(on: boolean, vol: number, clickLayer = true, clickPack = "soft", customClick = "", customHover = "") {
  enabled = on;
  volume = vol;
  clicks = clickLayer;
  pack = clickPack;
  custom.click = customClick;
  custom.hover = customHover;
}

/** Plays the user's own sound (a data: URL kept in the UI prefs), decoded once. */
function playCustom(a: AudioContext, url: string, gain: number) {
  const buf = decoded.get(url);
  if (buf === undefined) {
    decoded.set(url, null);
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => a.decodeAudioData(b))
      .then((b) => {
        decoded.set(url, b);
        playCustom(a, url, gain);
      })
      .catch(() => {});
    return;
  }
  if (!buf) return;
  const src = a.createBufferSource();
  const g = a.createGain();
  src.buffer = buf;
  g.gain.value = gain * volume;
  src.connect(g).connect(a.destination);
  src.start();
}

function ac(): AudioContext | null {
  try {
    ctx ||= new AudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** One soft note: sine/triangle with a quick attack and an exponential tail. */
function note(a: AudioContext, freq: number, at: number, len: number, gain: number, type: OscillatorType = "sine") {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime + at);
  const t0 = a.currentTime + at;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * volume), t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
  o.connect(g).connect(a.destination);
  o.start(t0);
  o.stop(t0 + len + 0.05);
}

export function sound(kind: UiSound, force = false) {
  if ((!enabled && !force) || volume <= 0) return;
  if (document.documentElement.classList.contains("snd-off")) return;
  const a = ac();
  if (!a) return;
  switch (kind) {
    case "launch": // rising major chord, like a door opening
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(a, f, i * 0.06, 0.45, 0.16, "triangle"));
      break;
    case "done":
      note(a, 880, 0, 0.18, 0.14);
      note(a, 1318.5, 0.09, 0.32, 0.14);
      break;
    case "error":
      note(a, 196, 0, 0.32, 0.18, "triangle");
      note(a, 164.8, 0.12, 0.42, 0.16, "triangle");
      break;
    case "notify":
      note(a, 1174.7, 0, 0.22, 0.1);
      note(a, 1568, 0.07, 0.3, 0.08);
      break;
    case "achievement":
      [784, 988, 1175, 1568].forEach((f, i) => note(a, f, i * 0.09, 0.5, 0.13, "square"));
      break;
    case "open":
      note(a, 1760, 0, 0.06, 0.05);
      break;
  }
}

/**
 * The global click/hover/toggle layer: tiny, soft ticks on the controls people touch. Kept very quiet
 * so it feels satisfying, not noisy. Gated by its own "clickLayer" preference on top of the master
 * sound toggle, and silent when sounds are off, volume is 0, or the secret mute class is set.
 */
export function uiTick(kind: "click" | "hover" | "toggle") {
  if (!enabled || !clicks || volume <= 0) return;
  if (document.documentElement.classList.contains("snd-off")) return;
  const a = ac();
  if (!a) return;
  if (pack === "custom") {
    // a toggle uses the click sound; no hover file = silent hover
    const url = kind === "hover" ? custom.hover : custom.click;
    if (url) playCustom(a, url, kind === "hover" ? 0.5 : 1);
    return;
  }
  if (pack === "pop") {
    if (kind === "hover") note(a, 1600, 0, 0.025, 0.012, "sine");
    else note(a, kind === "toggle" ? 660 : 520, 0, 0.08, 0.09, "sine"), note(a, kind === "toggle" ? 990 : 780, 0.02, 0.06, 0.05, "sine");
    return;
  }
  if (pack === "wood") {
    if (kind === "hover") note(a, 420, 0, 0.025, 0.02, "triangle");
    else note(a, kind === "toggle" ? 330 : 260, 0, 0.06, 0.12, "triangle"), note(a, 140, 0, 0.04, 0.08, "square");
    return;
  }
  if (pack === "retro") {
    if (kind === "hover") note(a, 1760, 0, 0.02, 0.01, "square");
    else note(a, 880, 0, 0.04, 0.04, "square"), note(a, kind === "toggle" ? 1760 : 1320, 0.04, 0.05, 0.035, "square");
    return;
  }
  switch (kind) {
    case "hover":
      note(a, 2100, 0, 0.03, 0.016, "sine");
      break;
    case "click":
      note(a, 1320, 0, 0.045, 0.05, "triangle");
      break;
    case "toggle":
      note(a, 880, 0, 0.05, 0.05, "triangle");
      note(a, 1320, 0.04, 0.06, 0.045, "triangle");
      break;
  }
}
