import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SkinViewer } from "skinview3d";
import { fixSkinAlpha } from "../skinAlpha";
import * as THREE from "three";
import { Icon } from "../icons";
import { Modal } from "./common";
import { tr } from "../i18n";

/**
 * 3D skin editor: paint straight onto the turning model. Left button paints, right drag turns,
 * right click picks a colour, the wheel zooms. Base/overlay layers, mirror painting, hiding body
 * parts (to reach the insides of arms and legs), fill, shading, undo/redo. Same tools as the in-game
 * wardrobe editor (Kuubl Mod), so a skin feels the same in both places.
 */

type Tool = "pencil" | "eraser" | "bucket" | "picker" | "darken" | "lighten";
type Part = "head" | "body" | "rightArm" | "leftArm" | "rightLeg" | "leftLeg";
const PARTS: Part[] = ["head", "body", "rightArm", "leftArm", "rightLeg", "leftLeg"];
const PART_NAMES: Record<Part, [string, string]> = {
  head: ["Hlava", "Head"],
  body: ["Tělo", "Body"],
  rightArm: ["P. ruka", "R arm"],
  leftArm: ["L. ruka", "L arm"],
  rightLeg: ["P. noha", "R leg"],
  leftLeg: ["L. noha", "L leg"],
};
const TOOLS: [Tool, string, string][] = [
  ["pencil", "Tužka", "Pencil"],
  ["eraser", "Guma", "Eraser"],
  ["bucket", "Výplň", "Fill"],
  ["picker", "Kapátko", "Picker"],
  ["darken", "Ztmavit", "Darken"],
  ["lighten", "Zesvětlit", "Lighten"],
];
const PALETTE = [
  "#000000", "#3f3f46", "#71717a", "#a1a1aa", "#e4e4e7", "#ffffff",
  "#7f1d1d", "#dc2626", "#f87171", "#9a3412", "#f97316", "#fdba74",
  "#854d0e", "#eab308", "#fde047", "#14532d", "#16a34a", "#86efac",
  "#1e3a8a", "#2563eb", "#93c5fd", "#581c87", "#9333ea", "#d8b4fe",
  "#5b3a1e", "#8b5a2b", "#c68642", "#e0ac69", "#f1c27d", "#ffdbac",
];

// ---- skin layout (Minecraft's box UV), same as the mod's SkinRender3D
interface Box { part: Part; w: number; h: number; d: number; u: number; v: number; ou: number; ov: number }
const boxes = (slim: boolean): Box[] => {
  const a = slim ? 3 : 4;
  return [
    { part: "head", w: 8, h: 8, d: 8, u: 0, v: 0, ou: 32, ov: 0 },
    { part: "body", w: 8, h: 12, d: 4, u: 16, v: 16, ou: 16, ov: 32 },
    { part: "rightArm", w: a, h: 12, d: 4, u: 40, v: 16, ou: 40, ov: 32 },
    { part: "leftArm", w: a, h: 12, d: 4, u: 32, v: 48, ou: 48, ov: 48 },
    { part: "rightLeg", w: 4, h: 12, d: 4, u: 0, v: 16, ou: 0, ov: 32 },
    { part: "leftLeg", w: 4, h: 12, d: 4, u: 16, v: 48, ou: 0, ov: 48 },
  ];
};
// front, back, right side, left side, top, bottom
const faceRect = (b: Box, face: number, outer: boolean): [number, number, number, number] => {
  const u = outer ? b.ou : b.u, v = outer ? b.ov : b.v, { w, h, d } = b;
  switch (face) {
    case 0: return [u + d, v + d, w, h];
    case 1: return [u + d * 2 + w, v + d, w, h];
    case 2: return [u, v + d, d, h];
    case 3: return [u + d + w, v + d, d, h];
    case 4: return [u + d, v, w, d];
    default: return [u + d + w, v, w, d];
  }
};
interface Spot { box: Box; face: number; outer: boolean; i: number; j: number }
/** Which part/face/texel a skin pixel belongs to (null for unused pixels). */
const locate = (x: number, y: number, slim: boolean): Spot | null => {
  for (const box of boxes(slim))
    for (const outer of [false, true])
      for (let face = 0; face < 6; face++) {
        const [fx, fy, fw, fh] = faceRect(box, face, outer);
        if (x >= fx && x < fx + fw && y >= fy && y < fy + fh) return { box, face, outer, i: x - fx, j: y - fy };
      }
  return null;
};
const MIRROR: Record<Part, Part> = { head: "head", body: "body", rightArm: "leftArm", leftArm: "rightArm", rightLeg: "leftLeg", leftLeg: "rightLeg" };
/** The same spot on the other side of the body (left ↔ right). */
const mirrorOf = (x: number, y: number, slim: boolean): [number, number] | null => {
  const s = locate(x, y, slim);
  if (!s) return null;
  const mb = boxes(slim).find((b) => b.part === MIRROR[s.box.part])!;
  const mf = s.face === 2 ? 3 : s.face === 3 ? 2 : s.face;
  const [fx, fy, fw] = faceRect(mb, mf, s.outer);
  return [fx + fw - 1 - s.i, fy + s.j];
};

const hex = (n: number) => "#" + (n & 0xffffff).toString(16).padStart(6, "0");
const rgba = (d: Uint8ClampedArray, i: number) => [d[i], d[i + 1], d[i + 2], d[i + 3]];

export interface PainterProps {
  /** Library skin to start from, or null for a blank one. */
  skinId: string | null;
  name: string;
  slim: boolean;
  accountId?: string;
  onClose: () => void;
  onSaved: () => void;
}

export default function SkinPainter({ skinId, name: startName, slim: startSlim, accountId, onClose, onSaved }: PainterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<SkinViewer | null>(null);
  const skin = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const undo = useRef<ImageData[]>([]);
  const redo = useRef<ImageData[]>([]);
  const stroke = useRef<{ painting: boolean; done: Set<number>; x: number; y: number }>({ painting: false, done: new Set(), x: 0, y: 0 });
  const rightDown = useRef<{ x: number; y: number } | null>(null);

  const [ready, setReady] = useState(false);
  const [slim, setSlim] = useState(startSlim);
  const [name, setName] = useState(startName);
  const [tool, setTool] = useState<Tool>("pencil");
  const [layer, setLayer] = useState<"base" | "overlay">("base");
  const [showOuter, setShowOuter] = useState(true);
  const [mirror, setMirror] = useState(false);
  const [parts, setParts] = useState<Record<Part, boolean>>({ head: true, body: true, rightArm: true, leftArm: true, rightLeg: true, leftLeg: true });
  const [color, setColor] = useState("#dc2626");
  const [recent, setRecent] = useState<string[]>([]);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Latest state for the pointer handlers (attached once).
  const st = useRef({ tool, layer, mirror, color, slim });
  st.current = { tool, layer, mirror, color, slim };

  const refresh = useCallback(() => {
    viewer.current?.loadSkin(skin.current, { model: st.current.slim ? "slim" : "default" });
  }, []);

  // ---- load the skin into the work canvas
  useEffect(() => {
    const c = skin.current;
    c.width = 64;
    c.height = 64;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    const blank = () => {
      g.clearRect(0, 0, 64, 64);
      g.fillStyle = "#8b8b95";
      for (const b of boxes(false)) for (let f = 0; f < 6; f++) {
        const [x, y, w, h] = faceRect(b, f, false);
        g.fillRect(x, y, w, h);
      }
      setReady(true);
    };
    if (!skinId) return blank();
    invoke<string>("skinlib_read", { id: skinId })
      .then((b64) => {
        const img = new Image();
        img.onload = () => {
          g.clearRect(0, 0, 64, 64);
          g.drawImage(img, 0, 0);
          // Old 64×32 skins: mirror the arm and leg into the left-side slots.
          if (img.height === 32) {
            g.drawImage(img, 0, 16, 16, 16, 16, 48, 16, 16);
            g.drawImage(img, 40, 16, 16, 16, 32, 48, 16, 16);
          }
          setReady(true);
        };
        img.src = "data:image/png;base64," + b64;
      })
      .catch((e) => {
        setErr(String(e));
        blank();
      });
  }, [skinId]);

  // ---- 3D viewer
  useEffect(() => {
    if (!ready || !canvasRef.current) return;
    const v = new SkinViewer({ canvas: canvasRef.current, width: 420, height: 460 });
    v.fov = 40;
    v.zoom = 0.85;
    v.background = null as unknown as THREE.Color;
    v.autoRotate = false;
    v.animation = null;
    v.controls.enablePan = false;
    v.controls.mouseButtons = { LEFT: -1 as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    v.playerObject.rotation.y = 0.5;
    fixSkinAlpha(v);
    viewer.current = v;
    refresh();
    return () => {
      v.dispose();
      viewer.current = null;
    };
  }, [ready, refresh]);

  // Slim / wide arms.
  useEffect(() => refresh(), [slim, refresh]);

  // Visible parts and layers.
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    for (const p of PARTS) {
      const bp = v.playerObject.skin[p];
      bp.visible = parts[p];
      bp.outerLayer.visible = layer === "overlay" || showOuter;
    }
  }, [parts, layer, showOuter, ready]);

  // ---- painting
  const ctx = () => skin.current.getContext("2d", { willReadFrequently: true })!;

  const snapshot = () => {
    undo.current.push(ctx().getImageData(0, 0, 64, 64));
    if (undo.current.length > 60) undo.current.shift();
    redo.current = [];
    setHist({ undo: undo.current.length, redo: 0 });
  };
  const undoStep = () => {
    const d = undo.current.pop();
    if (!d) return;
    redo.current.push(ctx().getImageData(0, 0, 64, 64));
    ctx().putImageData(d, 0, 0);
    setHist({ undo: undo.current.length, redo: redo.current.length });
    refresh();
  };
  const redoStep = () => {
    const d = redo.current.pop();
    if (!d) return;
    undo.current.push(ctx().getImageData(0, 0, 64, 64));
    ctx().putImageData(d, 0, 0);
    setHist({ undo: undo.current.length, redo: redo.current.length });
    refresh();
  };

  const remember = (c: string) => setRecent((r) => [c, ...r.filter((x) => x !== c)].slice(0, 12));

  /** Texel {x, y} under the pointer on the active layer, or null. */
  const hit = (e: { clientX: number; clientY: number }): [number, number] | null => {
    const v = viewer.current;
    const el = canvasRef.current;
    if (!v || !el) return null;
    const r = el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, v.camera);
    const targets: THREE.Object3D[] = [];
    for (const p of PARTS) {
      const bp = v.playerObject.skin[p];
      if (!bp.visible) continue;
      targets.push(st.current.layer === "overlay" ? bp.outerLayer : bp.innerLayer);
    }
    const h = ray.intersectObjects(targets, true)[0];
    if (!h?.uv) return null;
    const x = Math.min(63, Math.floor(h.uv.x * 64)), y = Math.min(63, Math.floor((1 - h.uv.y) * 64));
    return [x, y];
  };

  const applyOne = (x: number, y: number) => {
    const g = ctx();
    const { tool, color } = st.current;
    const d = g.getImageData(x, y, 1, 1).data;
    const outer = locate(x, y, st.current.slim)?.outer ?? false;
    switch (tool) {
      case "picker":
        if (d[3] > 0) setColor(hex((d[0] << 16) | (d[1] << 8) | d[2]));
        setTool("pencil");
        return;
      case "eraser":
        if (outer) g.clearRect(x, y, 1, 1);
        return;
      case "bucket": {
        const s = locate(x, y, st.current.slim);
        if (!s) return;
        const [fx, fy, fw, fh] = faceRect(s.box, s.face, s.outer);
        const img = g.getImageData(0, 0, 64, 64);
        const from = rgba(img.data, (y * 64 + x) * 4).join();
        const to = parseInt(color.slice(1), 16);
        const q: [number, number][] = [[x, y]];
        const seen = new Set<number>();
        while (q.length) {
          const [qx, qy] = q.pop()!;
          if (qx < fx || qy < fy || qx >= fx + fw || qy >= fy + fh || seen.has(qy * 64 + qx)) continue;
          seen.add(qy * 64 + qx);
          const i = (qy * 64 + qx) * 4;
          if (rgba(img.data, i).join() !== from) continue;
          img.data[i] = (to >> 16) & 255;
          img.data[i + 1] = (to >> 8) & 255;
          img.data[i + 2] = to & 255;
          img.data[i + 3] = 255;
          q.push([qx + 1, qy], [qx - 1, qy], [qx, qy + 1], [qx, qy - 1]);
        }
        g.putImageData(img, 0, 0);
        return;
      }
      case "darken":
      case "lighten": {
        const key = y * 64 + x;
        if (d[3] === 0 || stroke.current.done.has(key)) return;
        stroke.current.done.add(key);
        const k = tool === "darken" ? 0.86 : 1.14, add = tool === "lighten" ? 6 : 0;
        const c = [0, 1, 2].map((i) => Math.min(255, Math.round(d[i] * k + add)));
        g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${d[3] / 255})`;
        g.clearRect(x, y, 1, 1);
        g.fillRect(x, y, 1, 1);
        return;
      }
      default:
        g.fillStyle = color;
        g.clearRect(x, y, 1, 1);
        g.fillRect(x, y, 1, 1);
    }
  };

  const apply = (x: number, y: number) => {
    applyOne(x, y);
    if (st.current.mirror) {
      const m = mirrorOf(x, y, st.current.slim);
      if (m && (m[0] !== x || m[1] !== y)) applyOne(m[0], m[1]);
    }
    refresh();
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button === 2) {
      rightDown.current = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.button !== 0) return;
    const t = hit(e);
    if (!t) return;
    const { tool, color } = st.current;
    if (tool !== "picker") snapshot();
    if (tool === "pencil" || tool === "bucket") remember(color);
    stroke.current = { painting: tool !== "picker" && tool !== "bucket", done: new Set(), x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture(e.pointerId);
    apply(t[0], t[1]);
  };
  const onMove = (e: React.PointerEvent) => {
    const s = stroke.current;
    if (!s.painting) return;
    // Sample every ~2 px between the last and this pointer position: fast strokes leave no gaps.
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 2));
    let last = -1;
    for (let k = 1; k <= steps; k++) {
      const t = hit({ clientX: s.x + (dx * k) / steps, clientY: s.y + (dy * k) / steps });
      if (!t || t[1] * 64 + t[0] === last) continue;
      last = t[1] * 64 + t[0];
      applyOne(t[0], t[1]);
      if (st.current.mirror) {
        const m = mirrorOf(t[0], t[1], st.current.slim);
        if (m) applyOne(m[0], m[1]);
      }
    }
    s.x = e.clientX;
    s.y = e.clientY;
    refresh();
  };
  const onUp = (e: React.PointerEvent) => {
    stroke.current.painting = false;
    const r = rightDown.current;
    rightDown.current = null;
    // Right click without dragging: pick the colour.
    if (e.button === 2 && r && Math.abs(r.x - e.clientX) + Math.abs(r.y - e.clientY) < 4) {
      const t = hit(e);
      if (!t) return;
      const d = ctx().getImageData(t[0], t[1], 1, 1).data;
      if (d[3] > 0) setColor(hex((d[0] << 16) | (d[1] << 8) | d[2]));
    }
  };

  // Ctrl+Z / Ctrl+Y.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undoStep();
      } else if (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey)) {
        e.preventDefault();
        redoStep();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const turn = (y: number) => {
    const v = viewer.current;
    if (!v) return;
    v.controls.reset();
    v.playerObject.rotation.y = y;
  };

  const save = async (wear: boolean) => {
    setBusy(true);
    setErr("");
    try {
      const png = skin.current.toDataURL("image/png").split(",")[1];
      await invoke("skinlib_save", { png, name: name.trim() || "Skin", variant: slim ? "slim" : "classic", account: wear ? accountId ?? null : null });
      onSaved();
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={
        <span className="row">
          <Icon name="edit" /> {tr("Editor skinu", "Skin editor")}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          {err && <span className="small" style={{ color: "var(--red)", marginRight: "auto" }}>{err}</span>}
          <button className="btn ghost" onClick={onClose}>{tr("Zrušit", "Cancel")}</button>
          <button className="btn" disabled={busy} onClick={() => save(false)}>{tr("Uložit do knihovny", "Save to library")}</button>
          {accountId && (
            <button className="btn primary" disabled={busy} onClick={() => save(true)}>
              <Icon name="check" size={16} /> {tr("Uložit a nasadit", "Save & wear")}
            </button>
          )}
        </>
      }
    >
      <div className="sp-wrap">
        <div className="sp-view">
          <div className="sp-viewbar">
            <button className="chip" onClick={() => turn(0)}>{tr("Zepředu", "Front")}</button>
            <button className="chip" onClick={() => turn(Math.PI)}>{tr("Zezadu", "Back")}</button>
            <button className="chip" onClick={() => turn(0.5)}>Reset</button>
          </div>
          <canvas
            ref={canvasRef}
            className={`sp-canvas tool-${tool}`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onContextMenu={(e) => e.preventDefault()}
          />
          <div className="small muted sp-hint">{tr("Levé: kreslit · pravé tažení: otočit · kolečko: zoom · pravý klik: barva", "Left: paint · right drag: turn · wheel: zoom · right click: pick colour")}</div>
        </div>
        <div className="sp-side col">
          <div className="sp-row">
            <span className="sp-label">{tr("Vrstva", "Layer")}</span>
            <div className="chips">
              <button className={`chip ${layer === "base" ? "on" : ""}`} onClick={() => setLayer("base")}>{tr("Základ", "Base")}</button>
              <button className={`chip ${layer === "overlay" ? "on" : ""}`} onClick={() => setLayer("overlay")}>{tr("Vrchní", "Overlay")}</button>
              {layer === "base" && (
                <button className={`chip ${showOuter ? "" : "on"}`} onClick={() => setShowOuter(!showOuter)}>{showOuter ? tr("Skrýt vrchní", "Hide outer") : tr("Ukázat vrchní", "Show outer")}</button>
              )}
            </div>
          </div>
          <div className="sp-row">
            <span className="sp-label">{tr("Nástroj", "Tool")}</span>
            <div className="chips">
              {TOOLS.map(([id, cs, en]) => (
                <button key={id} className={`chip ${tool === id ? "on" : ""}`} disabled={id === "eraser" && layer === "base"} onClick={() => setTool(id)}>
                  {tr(cs, en)}
                </button>
              ))}
            </div>
          </div>
          <div className="sp-row">
            <span className="sp-label">{tr("Volby", "Options")}</span>
            <div className="chips">
              <button className={`chip ${mirror ? "on" : ""}`} onClick={() => setMirror(!mirror)}>{tr("Zrcadlit", "Mirror")}</button>
              <button className={`chip ${slim ? "on" : ""}`} onClick={() => setSlim(!slim)}>{slim ? tr("Úzké ruce", "Slim arms") : tr("Široké ruce", "Wide arms")}</button>
            </div>
          </div>
          <div className="sp-row">
            <span className="sp-label">{tr("Části", "Parts")}</span>
            <div className="chips">
              {PARTS.map((p) => (
                <button
                  key={p}
                  className={`chip ${parts[p] ? "on" : ""}`}
                  onClick={() => setParts((s) => (Object.values({ ...s, [p]: !s[p] }).some(Boolean) ? { ...s, [p]: !s[p] } : s))}
                >
                  {tr(...PART_NAMES[p])}
                </button>
              ))}
            </div>
          </div>
          <div className="sp-row">
            <span className="sp-label">{tr("Barva", "Colour")}</span>
            <div className="col" style={{ gap: 8 }}>
              <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                <input type="color" className="sp-color" value={color} onChange={(e) => setColor(e.target.value)} />
                <div className="sp-palette">
                  {PALETTE.map((c) => (
                    <button key={c} className={`sp-swatch ${c === color ? "on" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />
                  ))}
                </div>
              </div>
              {recent.length > 0 && (
                <div className="sp-palette recent">
                  {recent.map((c) => (
                    <button key={c} className={`sp-swatch ${c === color ? "on" : ""}`} style={{ background: c }} onClick={() => setColor(c)} title={c} />
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="sp-row">
            <span className="sp-label" />
            <div className="chips">
              <button className="chip" disabled={!hist.undo} onClick={undoStep}>{tr("Zpět", "Undo")}</button>
              <button className="chip" disabled={!hist.redo} onClick={redoStep}>{tr("Znovu", "Redo")}</button>
            </div>
          </div>
          <div className="sp-row">
            <span className="sp-label">{tr("Název", "Name")}</span>
            <input className="input grow" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
      </div>
    </Modal>
  );
}
