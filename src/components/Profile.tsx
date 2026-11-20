// Player profile (3D skin + real numbers, shareable as a picture) and Kuubl Wrapped (the year in
// review). Everything comes from local data: instances' play time, the play history the launcher
// keeps since 1.1 (history.rs), clips, Kuubl Mod's PvP totals and the found secrets.
import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { IdleAnimation, SkinViewer } from "skinview3d";
import { api, clips as clipsApi, social, type Account, type Clip, type PvpStats, type PlaySession } from "../api";
import { Icon } from "../icons";
import { fmtDuration, useStore } from "../store";
import { Modal } from "./common";
import { fixSkinAlpha } from "../skinAlpha";
import { secretsFound } from "./Secrets";
import { tr } from "../i18n";

// ---------- Data ----------

type Top = { name: string; secs: number } | null;

function topBy<T>(items: T[], key: (t: T) => string, secs: (t: T) => number): Top {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    if (k) m.set(k, (m.get(k) ?? 0) + secs(it));
  }
  let best: Top = null;
  for (const [name, s] of m) if (!best || s > best.secs) best = { name, secs: s };
  return best;
}

/** Numbers for the profile (all time) or Wrapped (one year). */
/** A Wrapped period: a whole year, or one month of it (0 = January). */
export type Period = { year: number; month?: number };

/** Numbers for the profile (no period = all time) or Wrapped (a year or a month). */
export function useStats(period?: Period) {
  const year = period?.year;
  const month = period?.month;
  const { instances } = useStore();
  const [history, setHistory] = useState<PlaySession[] | null>(null);
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [pvp, setPvp] = useState<PvpStats | null>(null);
  useEffect(() => {
    api.playHistory().then(setHistory).catch(() => setHistory([]));
    clipsApi.list().then(setClips).catch(() => setClips([]));
    social.pvpStats().then(setPvp).catch(() => setPvp(null));
  }, []);
  return useMemo(() => {
    const inYear = (ts: number) => {
      if (!year) return true;
      const d = new Date(ts * 1000);
      return d.getFullYear() === year && (month === undefined || d.getMonth() === month);
    };
    const sessions = (history ?? []).filter((s) => inYear(s.start));
    const allTime = instances.reduce((n, i) => n + (i.playtimeSecs || 0), 0);
    const topAllTime = instances.reduce<Top>((b, i) => (i.playtimeSecs > (b?.secs ?? 0) ? { name: i.name, secs: i.playtimeSecs } : b), null);
    // The year the history started (or no history yet) also gets everything played before it: the
    // instances' totals. Kuubl/Justice only exists since 2026, so that's this year's real play time.
    const firstYear = history?.[0] ? new Date(history[0].start * 1000).getFullYear() : new Date().getFullYear();
    const withOld = !year || (month === undefined && year === firstYear);
    const sessionSecs = sessions.reduce((n, s) => n + s.secs, 0);
    const played = withOld ? Math.max(allTime, sessionSecs) : sessionSecs;
    const topInstance: Top = withOld ? topAllTime : topBy(sessions, (s) => s.name, (s) => s.secs);
    const topServer = topBy(sessions.filter((s) => s.placeKind === "server"), (s) => s.place, (s) => s.secs);
    const topVersion = topBy(sessions, (s) => s.mc, (s) => s.secs);
    const longest = sessions.reduce<PlaySession | null>((b, s) => (!b || s.secs > b.secs ? s : b), null);
    const yearClips = (clips ?? []).filter((c) => inYear(c.modified));
    const [found, total] = secretsFound();
    return {
      ready: history !== null && clips !== null,
      played,
      sessions: sessions.length,
      topInstance,
      topServer,
      topVersion,
      longest,
      clips: yearClips.length,
      pvp,
      secrets: [found, total] as const,
      historySince: history?.[0]?.start ?? null,
    };
  }, [history, clips, pvp, instances, year, month]);
}

// ---------- 3D player that can be captured ----------

function Player({ account, onViewer }: { account: Account; onViewer?: (v: SkinViewer) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    // preserveDrawingBuffer so the share picture can copy the current frame
    const v = new SkinViewer({ canvas: canvas.current, width: 220, height: 300, preserveDrawingBuffer: true });
    v.animation = new IdleAnimation();
    v.controls.enableZoom = false;
    v.playerObject.rotation.y = -0.45;
    fixSkinAlpha(v);
    const url = account.skinUrl || `https://mc-heads.net/skin/${account.uuid.replace(/-/g, "")}`;
    api.fetchImage(url).then((d) => v.loadSkin(d, { model: account.skinVariant === "SLIM" ? "slim" : "default" })).catch(() => v.loadSkin(null));
    onViewer?.(v);
    return () => v.dispose();
  }, [account.uuid, account.skinUrl, account.skinVariant]);
  return <canvas ref={canvas} className="pf-player" />;
}

// ---------- Share picture ----------

function loadImg(src: string) {
  return new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

/** 1200×630 card: the sunset with the player on the left, the numbers on the right. */
async function renderCard(title: string, name: string, rows: [string, string][], skin: HTMLCanvasElement | null) {
  await document.fonts.ready;
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 630;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0b0a10";
  g.fillRect(0, 0, 1200, 630);
  try {
    const bg = await loadImg("/bg/sunset.webp");
    const w = 470, s = Math.max(w / bg.width, 630 / bg.height);
    g.drawImage(bg, (w - bg.width * s) / 2, (630 - bg.height * s) / 2, bg.width * s, bg.height * s);
  } catch {}
  const fade = g.createLinearGradient(330, 0, 470, 0);
  fade.addColorStop(0, "rgba(11,10,16,0)");
  fade.addColorStop(1, "#0b0a10");
  g.fillStyle = fade;
  g.fillRect(330, 0, 140, 630);
  if (skin) g.drawImage(skin, 235 - 160, 90, 320, 436);
  try {
    const logo = await loadImg("/secrets/kuubl.png");
    g.drawImage(logo, 520, 48, 44, 44);
  } catch {}
  g.fillStyle = "#f0661f";
  g.font = "800 22px 'Inter Tight', Inter, sans-serif";
  g.fillText(title.toUpperCase(), 578, 80);
  g.fillStyle = "#eef0f3";
  g.font = "800 56px 'Inter Tight', Inter, sans-serif";
  g.fillText(name, 520, 165);
  let y = 235;
  for (const [label, value] of rows.slice(0, 6)) {
    g.fillStyle = "#8b919c";
    g.font = "600 20px 'Inter Tight', Inter, sans-serif";
    g.fillText(label, 520, y);
    g.fillStyle = "#eef0f3";
    g.font = "800 30px 'Inter Tight', Inter, sans-serif";
    g.fillText(value, 520, y + 36);
    y += 64;
  }
  g.fillStyle = "#55555c";
  g.font = "600 16px 'Inter Tight', Inter, sans-serif";
  g.fillText("ertenix.net/kuubl", 1020, 600);
  return new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("canvas"))), "image/png"));
}

function ShareButtons({ make, file }: { make: () => Promise<Blob>; file: string }) {
  const { toast } = useStore();
  const [busy, setBusy] = useState(false);
  const run = async (how: "copy" | "save") => {
    setBusy(true);
    try {
      const blob = await make();
      if (how === "copy") {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        toast(tr("Obrázek je ve schránce, vlož ho třeba na Discord (Ctrl+V)", "The picture is on your clipboard, paste it e.g. on Discord (Ctrl+V)"), "success");
      } else {
        const path = await save({ defaultPath: file, filters: [{ name: "PNG", extensions: ["png"] }] });
        if (!path) return;
        await invoke("save_png", { path, data: Array.from(new Uint8Array(await blob.arrayBuffer())) });
        toast(tr("Obrázek uložen", "Picture saved"), "success");
      }
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="btn" disabled={busy} onClick={() => run("save")}>
        <Icon name="download" size={14} /> {tr("Uložit obrázek", "Save picture")}
      </button>
      <button className="btn primary" disabled={busy} onClick={() => run("copy")}>
        <Icon name="share" size={14} /> {tr("Kopírovat pro sdílení", "Copy to share")}
      </button>
    </>
  );
}

// ---------- Profile ----------

export function ProfileModal({ onClose }: { onClose: () => void }) {
  const { activeAccount } = useStore();
  const st = useStats();
  const viewer = useRef<SkinViewer | null>(null);
  const [wrapped, setWrapped] = useState(false);
  if (wrapped) return <WrappedModal onClose={onClose} />;
  const name = activeAccount?.username ?? tr("Hráč", "Player");
  const rows: [string, string][] = [
    [tr("Odehráno", "Played"), fmtDuration(st.played)],
    [tr("Nejhranější instance", "Most played instance"), st.topInstance ? st.topInstance.name : "—"],
    [tr("Oblíbený server", "Favourite server"), st.topServer?.name ?? "—"],
    [tr("Klipy", "Clips"), String(st.clips)],
    ...(st.pvp && (st.pvp.kills || st.pvp.deaths) ? [[tr("Zabití / smrti", "Kills / deaths"), `${st.pvp.kills} / ${st.pvp.deaths}`] as [string, string]] : []),
    [tr("Tajemství", "Secrets"), `${st.secrets[0]} / ${st.secrets[1]}`],
  ];
  return (
    <Modal
      title={tr("Můj profil", "My profile")}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={() => setWrapped(true)}>
            <Icon name="sparkles" size={14} /> Kuubl Wrapped {new Date().getFullYear()}
          </button>
          <div className="grow" />
          <ShareButtons file={`kuubl-${name}.png`} make={() => renderCard(tr("Profil hráče", "Player profile"), name, rows, viewer.current?.canvas ?? null)} />
        </>
      }
    >
      <div className="pf">
        <div className="pf-stage">
          {activeAccount && <Player account={activeAccount} onViewer={(v) => (viewer.current = v)} />}
        </div>
        <div className="pf-info">
          <h2>{name}</h2>
          <div className="pf-grid">
            {rows.map(([l, v]) => (
              <div key={l} className="pf-cell">
                <small>{l}</small>
                <b className="ellipsis" title={v}>{v}</b>
              </div>
            ))}
          </div>
          {st.historySince === null && (
            <p className="muted small">{tr("Oblíbený server a další detaily se začnou počítat od téhle verze, jak budeš hrát.", "Favourite server and other details start counting from this version as you play.")}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------- Wrapped ----------

const monthName = (m: number) => new Date(2026, m, 1).toLocaleString(tr("cs-CZ", "en-GB"), { month: "long" });
/** "listopad 2026" / "Wrapped 2026" */
export function periodLabel(p: Period) {
  return p.month === undefined ? `Wrapped ${p.year}` : `${monthName(p.month)} ${p.year}`;
}
/** The month that just ended (shown during the first week of the next one). */
export function lastMonth(d = new Date()): Period {
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return { year: prev.getFullYear(), month: prev.getMonth() };
}
/** The monthly recap is offered on Home during the first 7 days of a month. */
export function monthlySeason(d = new Date()) {
  return d.getDate() <= 7;
}

export function WrappedModal({ onClose, period }: { onClose: () => void; period?: Period }) {
  const { activeAccount } = useStore();
  // without a period: this year (in early January still last year)
  const p: Period = period ?? { year: new Date().getMonth() === 0 ? new Date().getFullYear() - 1 : new Date().getFullYear() };
  const year = p.year;
  const monthly = p.month !== undefined;
  const st = useStats(p);
  // "letos" / "v listopadu": the same slides read right for a year and for a month
  const when = monthly ? tr(`za ${monthName(p.month!)}`, `in ${monthName(p.month!)}`) : tr("letos", "this year");
  const [i, setI] = useState(0);
  const name = activeAccount?.username ?? tr("Hráč", "Player");
  const hours = Math.round(st.played / 360) / 10;
  const slides: { c: string; icon: string; big: string; text: string }[] = [
    { c: "#ff7a2f", icon: "clock", big: `${hours} h`, text: tr(`Tolik jsi ${when} odehrál přes Kuubl.`, `That's how long you played through Kuubl ${when}.`) },
    ...(st.topInstance ? [{ c: "#22d3ee", icon: "box", big: st.topInstance.name, text: tr(`Tvoje nejhranější instance: ${fmtDuration(st.topInstance.secs)}.`, `Your most played instance: ${fmtDuration(st.topInstance.secs)}.`) }] : []),
    ...(st.topServer ? [{ c: "#60a5fa", icon: "server", big: st.topServer.name, text: tr(`Tvůj server ${monthly ? "měsíce" : "roku"}: ${fmtDuration(st.topServer.secs)} na něm.`, `Your server of the ${monthly ? "month" : "year"}: ${fmtDuration(st.topServer.secs)} on it.`) }] : []),
    ...(st.topVersion ? [{ c: "#a78bfa", icon: "puzzle", big: st.topVersion.name, text: tr("Verze Minecraftu, kterou jsi hrál nejvíc.", "The Minecraft version you played the most.") }] : []),
    { c: "#f87171", icon: "clips", big: String(st.clips), text: tr(`klipů jsi ${when} uložil.`, `clips you saved ${when}.`) },
    ...(!monthly && st.pvp && (st.pvp.kills || st.pvp.deaths) ? [{ c: "#ef4444", icon: "zap", big: `${st.pvp.kills} / ${st.pvp.deaths}`, text: tr(`Zabití a smrti v PvP (nejlepší kombo ${st.pvp.bestCombo}).`, `PvP kills and deaths (best combo ${st.pvp.bestCombo}).`) }] : []),
    ...(st.longest ? [{ c: "#4ade80", icon: "trophy", big: fmtDuration(st.longest.secs), text: tr(`Nejdelší hraní v kuse: ${st.longest.name}.`, `Your longest session: ${st.longest.name}.`) }] : []),
    ...(monthly ? [] : [{ c: "#fbbf24", icon: "sparkles", big: `${st.secrets[0]} / ${st.secrets[1]}`, text: tr("nalezených tajemství v launcheru.", "secrets found in the launcher.") }]),
  ];
  const s = slides[Math.min(i, slides.length - 1)];
  const rows: [string, string][] = [
    [tr("Odehráno", "Played"), `${hours} h`],
    [monthly ? tr("Instance měsíce", "Instance of the month") : tr("Instance roku", "Instance of the year"), st.topInstance?.name ?? "—"],
    [monthly ? tr("Server měsíce", "Server of the month") : tr("Server roku", "Server of the year"), st.topServer?.name ?? "—"],
    [tr("Klipy", "Clips"), String(st.clips)],
    ...(st.pvp && (st.pvp.kills || st.pvp.deaths) ? [[tr("Zabití / smrti", "Kills / deaths"), `${st.pvp.kills} / ${st.pvp.deaths}`] as [string, string]] : []),
  ];
  return (
    <Modal
      title={monthly ? tr(`Tvůj ${periodLabel(p)} v Kuublu`, `Your ${periodLabel(p)} in Kuubl`) : `Kuubl Wrapped ${year}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" disabled={i === 0} onClick={() => setI(i - 1)}>
            <Icon name="left" size={14} /> {tr("Zpět", "Back")}
          </button>
          <span className="muted small">{i + 1} / {slides.length}</span>
          <div className="grow" />
          {i < slides.length - 1 ? (
            <button className="btn primary" onClick={() => setI(i + 1)}>
              {tr("Dál", "Next")} <Icon name="right" size={14} />
            </button>
          ) : (
            <ShareButtons file={`kuubl-wrapped-${year}${monthly ? `-${p.month! + 1}` : ""}.png`} make={() => renderCard(periodLabel(p), name, rows, null)} />
          )}
        </>
      }
    >
      {!st.ready ? (
        <div className="muted" style={{ padding: 40, textAlign: "center" }}>…</div>
      ) : (
        <div className="wr-slide" key={i} style={{ "--c": s.c } as React.CSSProperties}>
          <span className="wr-ic"><Icon name={s.icon} size={30} /></span>
          <div className="wr-big">{s.big}</div>
          <p>{s.text}</p>
          {i === 0 && !monthly && (
            <p className="muted small">{tr("Započítaný je i všechen čas odehraný před touhle verzí. Servery a nejdelší hraní se zapisují od verze 1.1.", "All the time played before this version counts too. Servers and the longest session are recorded since version 1.1.")}</p>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Wrapped is offered on Home from 1 December to 7 January. */
export function wrappedSeason(d = new Date()) {
  return d.getMonth() === 11 || (d.getMonth() === 0 && d.getDate() <= 7);
}
