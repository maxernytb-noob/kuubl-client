// Home for the v4 designs (ui.design): "life" (the player's skin in front of a scene, colour-coded
// actions, server banners), "forge" (dark and dense, Feather-like) and "arcade" (store-like stage).
// The classic Home stays in Home.tsx.
import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { IdleAnimation, SkinViewer } from "skinview3d";
import { api, clips as clipsApi, type Account, type Instance, type ServerStatus, type SocialUser } from "../api";
import { Icon } from "../icons";
import { fmtAgo, fmtDuration, LOADER_LABEL, useStore } from "../store";
import { Avatar, customIconSrc, InstGlyph, parseIcon, TaskProgress } from "../components/common";
import CreateInstance from "../components/CreateInstance";
import { useJoinFriend } from "../components/FriendsPlaying";
import { PickInstance, QUICK_SERVERS, type QuickServer } from "../components/QuickJoin";
import { head } from "../achievements";
import { fixSkinAlpha } from "../skinAlpha";
import { uiPrefs, type Design } from "../ui";
import { tr } from "../i18n";
import { ProfileModal, WrappedModal, wrappedSeason } from "../components/Profile";
import { forgetPlace, placeImg, useFriends, useLastPlace, useVersionArt } from "./Home";

/** Loader colour, used for the tag and the stripe on a row. */
const LOADER_COLOR: Record<string, string> = { fabric: "#fbbf24", quilt: "#c084fc", forge: "#60a5fa", neoforge: "#fb923c", vanilla: "#4ade80" };
const loaderColor = (l: string) => LOADER_COLOR[l] ?? "#94a3b8";

/** Instances, last played first (never played ones by creation date). */
function useRecent() {
  const { instances } = useStore();
  return useMemo(() => [...instances].sort((a, b) => (b.lastPlayed || b.created / 1e6) - (a.lastPlayed || a.created / 1e6)), [instances]);
}

/** Picture for an instance card: the drop's art, else its last place, else nothing (a glyph is drawn). */
function useInstanceImage(inst: Instance | undefined) {
  const art = useVersionArt(inst?.mcVersion);
  const place = useLastPlace(inst?.id);
  return art?.image ?? placeImg(place);
}

function Thumb({ inst, className }: { inst: Instance; className?: string }) {
  const img = useInstanceImage(inst);
  const icon = customIconSrc(parseIcon(inst.icon).base);
  return (
    <span className={`v4-thumb ${className ?? ""}`} style={img ? { backgroundImage: `url("${img}")` } : undefined}>
      {!img && (icon ? <img src={icon} alt="" /> : <InstGlyph icon={inst.icon} template={inst.template} size={20} />)}
    </span>
  );
}

// ---------- What stands behind the player ----------

// Faces per version for the session (null = the version has none / isn't downloaded).
const panoramas = new Map<string, Promise<string[] | null>>();
function loadPanorama(version: string) {
  let p = panoramas.get(version);
  if (!p) {
    p = api.titlePanorama(version).then((files) => files.map((f) => convertFileSrc(f))).catch(() => null);
    panoramas.set(version, p);
  }
  return p;
}

/** The four side faces of a version's title panorama, scrolled sideways like the game's menu. */
function Panorama({ version, fallback }: { version: string; fallback: string }) {
  const [faces, setFaces] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFaces(null);
    setFailed(false);
    loadPanorama(version).then((f) => alive && (f ? setFaces(f) : setFailed(true)));
    return () => {
      alive = false;
    };
  }, [version]);
  if (failed) return <div className="v4-bg" style={{ backgroundImage: `url("${fallback}")` }} />;
  if (!faces) return <div className="v4-bg" />;
  // 0 front, 1 right, 2 back, 3 left; the first face again at the end so the loop has no jump
  return (
    <div className="v4-pano">
      <div className="strip">
        {[...faces, faces[0]].map((f, i) => (
          <img key={i} src={f} alt="" />
        ))}
      </div>
    </div>
  );
}

function HeroBackground({ inst }: { inst: Instance | undefined }) {
  const { settings } = useStore();
  const prefs = uiPrefs(settings?.ui);
  const art = useVersionArt(inst?.mcVersion);
  const place = useLastPlace(inst?.id);
  const sunset = "/bg/sunset.webp";
  if (prefs.heroBg === "panorama" && inst) return <Panorama version={inst.mcVersion} fallback={sunset} />;
  const url =
    prefs.heroBg === "drop" ? (art?.hd ?? art?.wide ?? art?.image) :
    prefs.heroBg === "shot" ? placeImg(place) :
    prefs.heroBg === "custom" && prefs.heroBgImage ? convertFileSrc(prefs.heroBgImage) :
    null;
  return <div className="v4-bg" style={{ backgroundImage: `url("${url ?? sunset}")` }} />;
}

// ---------- The player ----------

function PlayerModel({ account }: { account: Account }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<SkinViewer | null>(null);
  useEffect(() => {
    if (!canvas.current || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const v = new SkinViewer({ canvas: canvas.current, width: Math.max(160, r.width), height: Math.max(200, r.height) });
    v.animation = new IdleAnimation();
    v.zoom = 0.9;
    v.controls.enableZoom = false;
    v.controls.enablePan = false;
    v.playerObject.rotation.y = -0.4;
    fixSkinAlpha(v);
    viewer.current = v;
    // the model follows the window size
    const ro = new ResizeObserver(([e]) => v.setSize(Math.max(160, e.contentRect.width), Math.max(200, e.contentRect.height)));
    ro.observe(box.current);
    return () => {
      ro.disconnect();
      v.dispose();
    };
  }, []);
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    // by uuid: offline accounts without a Kuubl skin get the default one (by name it'd be a premium player's)
    const url = account.skinUrl || `https://mc-heads.net/skin/${account.uuid.replace(/-/g, "")}`;
    api.fetchImage(url)
      .then((d) => v.loadSkin(d, { model: account.skinVariant === "SLIM" ? "slim" : "default" }))
      .catch(() => v.loadSkin(null));
  }, [account.skinUrl, account.skinVariant, account.uuid]);
  return (
    <div className="v4-player" ref={box} title={tr("Táhni myší a otoč postavou", "Drag to turn the player")}>
      <canvas ref={canvas} />
    </div>
  );
}

// ---------- Rows, tiles, banners ----------

function PlayButtons({ inst, compact }: { inst: Instance; compact?: boolean }) {
  const { running, progress, play, go } = useStore();
  const isRunning = running.includes(inst.id);
  const busy = !!progress[inst.id];
  return (
    <div className="v4-acts">
      {isRunning ? (
        <>
          {!compact && (
            <button className="v4-btn" onClick={() => go({ page: "instance", id: inst.id, tab: "log" })}>
              <Icon name="file" size={14} /> Log
            </button>
          )}
          <button className="v4-btn stop" onClick={() => api.kill(inst.id)}>
            <Icon name="stop" size={14} /> {tr("Zastavit", "Stop")}
          </button>
        </>
      ) : (
        <button className="v4-btn go" disabled={busy} onClick={() => play(inst.id)}>
          {busy ? <span className="spinner" /> : <Icon name="play" size={14} />} {tr("Hrát", "Play")}
        </button>
      )}
      <button className="v4-btn sq" title={tr("Nastavení instance", "Instance settings")} onClick={() => go({ page: "instance", id: inst.id })}>
        <Icon name="settings" size={15} />
      </button>
    </div>
  );
}

function InstanceRow({ inst }: { inst: Instance }) {
  const { running, progress } = useStore();
  const isRunning = running.includes(inst.id);
  return (
    <div className={`v4-row ${isRunning ? "run" : ""}`} style={{ "--c": loaderColor(inst.loader) } as React.CSSProperties}>
      <Thumb inst={inst} />
      <div className="grow" style={{ minWidth: 0 }}>
        <b className="ellipsis">{inst.name}</b>
        <span className="sub">
          <span className="ld">{LOADER_LABEL[inst.loader] ?? inst.loader}</span>
          {isRunning ? <i>{tr("Běží", "Running")}</i> : null}
          {progress[inst.id] ? <span className="grow"><TaskProgress task={inst.id} /></span> : <>{isRunning ? " · " : ""}{inst.mcVersion} · {inst.lastPlayed ? fmtAgo(inst.lastPlayed) : tr("nehráno", "not played")}</>}
        </span>
      </div>
      <PlayButtons inst={inst} />
    </div>
  );
}

function useStatus(server: QuickServer) {
  const [st, setSt] = useState<ServerStatus | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const a of [server.address, server.fallback].filter(Boolean) as string[]) {
        try {
          const s = await api.pingServer(a);
          if (alive) setSt(s);
          return;
        } catch {}
      }
      if (alive) setSt(null);
    })();
    return () => {
      alive = false;
    };
  }, [server.address, server.fallback]);
  return st;
}

function ServerBanner({ server }: { server: QuickServer }) {
  const { instances, play, settings } = useStore();
  const st = useStatus(server);
  const [picking, setPicking] = useState(false);
  const inst = instances.find((i) => i.id === settings?.quickServers?.[server.id]);
  const join = () => (inst ? play(inst.id, server.address) : setPicking(true));
  return (
    <>
      {/* the server's own logo carries the name; its colour only as an accent */}
      <div className="v4-ban" style={{ "--a": server.accent } as React.CSSProperties} onClick={join} title={server.name}>
        <div className="grow" style={{ minWidth: 0 }}>
          {server.logo ? <img className="wm" src={server.logo} alt={server.name} /> : <b>{server.name}</b>}
          <span className="st">{st === undefined ? "…" : st ? <><i className="on" /> {st.online} {tr("hráčů online", "players online")}</> : <><i /> offline</>}</span>
        </div>
        <span className="join">
          <Icon name="play" size={12} /> {tr("Připojit", "Join")}
        </span>
      </div>
      {picking && <PickInstance server={server} onClose={() => setPicking(false)} onPicked={(i) => (setPicking(false), play(i.id, server.address))} />}
    </>
  );
}

function FriendsPanel({ friends, title = true }: { friends: SocialUser[] | null; title?: boolean }) {
  const { go, settings } = useStore();
  const join = useJoinFriend();
  const online = (friends ?? []).filter((f) => f.online).sort((a, b) => Number(!!b.presence?.server) - Number(!!a.presence?.server));
  return (
    <div className="v4-panel">
      {title && (
        <div className="v4-h">
          {tr("Kamarádi", "Friends")}
          <button className="link" onClick={() => go({ page: "friends" })}>{online.length ? `${online.length} online` : tr("Všichni", "All")}</button>
        </div>
      )}
      {friends === null ? (
        <div className="muted small">…</div>
      ) : !online.length ? (
        <div className="muted small" style={{ padding: "4px 2px" }}>
          {friends.length ? tr("Nikdo z kamarádů teď není online.", "None of your friends are online.") : tr("Přidej si kamarády a hrajte spolu.", "Add friends and play together.")}
        </div>
      ) : (
        online.slice(0, 5).map((f) => (
          <div key={f.uuid} className={`v4-fr ${f.presence?.state === "playing" ? "playing" : ""}`} onClick={() => go({ page: "friends" })}>
            <img src={head(f.uuid, 56)} alt="" />
            <div className="grow" style={{ minWidth: 0 }}>
              <b className="ellipsis">{f.name}</b>
              <span className="ellipsis">
                {f.presence?.server ? (settings?.streamerMode ? "••••••" : f.presence.server) : f.presence?.state === "playing" ? (f.presence.instance ?? f.presence.mc) : tr("V launcheru", "In the launcher")}
              </span>
            </div>
            {f.presence?.server && (
              <button className="v4-join" onClick={(e) => (e.stopPropagation(), join(f))}>
                {tr("Připojit", "Join")}
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ---------- Life ----------

let clipCountCache: { at: number; n: number } | null = null;

function Stats({ friends }: { friends: SocialUser[] | null }) {
  const { instances, go } = useStore();
  const [clipCount, setClipCount] = useState<number | null>(clipCountCache?.n ?? null);
  useEffect(() => {
    // listing reads every clip file: at most once a minute
    if (clipCountCache && Date.now() - clipCountCache.at < 60_000) return;
    clipsApi.list().then((l) => {
      clipCountCache = { at: Date.now(), n: l.length };
      setClipCount(l.length);
    }).catch(() => setClipCount(0));
  }, []);
  const played = instances.reduce((n, i) => n + (i.playtimeSecs || 0), 0);
  const online = (friends ?? []).filter((f) => f.online).length;
  const tiles: [string, string, string, string, () => void][] = [
    ["#ff7a2f", "clock", fmtDuration(played) || "0 min", tr("odehráno celkem", "played in total"), () => go({ page: "instances" })],
    ["#f87171", "clips", String(clipCount ?? "…"), tr("klipů", "clips"), () => go({ page: "clips" })],
    ["#a78bfa", "box", String(instances.length), tr("instancí", "instances"), () => go({ page: "instances" })],
    ["#4ade80", "users", String(online), tr("kamarádů online", "friends online"), () => go({ page: "friends" })],
  ];
  return (
    <div className="v4-stats">
      {tiles.map(([c, icon, v, l, on]) => (
        <button key={l} className="v4-st" style={{ "--c": c } as React.CSSProperties} onClick={on}>
          <span className="ic"><Icon name={icon} size={17} /></span>
          <span><b>{v}</b><small>{l}</small></span>
        </button>
      ))}
    </div>
  );
}

/** "My profile" and, in December, the Wrapped banner: the same on every v4 Home. */
function ProfileEntry() {
  const [open, setOpen] = useState<"profile" | "wrapped" | null>(null);
  return (
    <>
      <div className="v4-pentry">
        <button className="v4-btn" onClick={() => setOpen("profile")}>
          <Icon name="user" size={14} /> {tr("Můj profil", "My profile")}
        </button>
        {wrappedSeason() && (
          <button className="v4-btn wrapped" onClick={() => setOpen("wrapped")}>
            <Icon name="sparkles" size={14} /> Kuubl Wrapped {new Date().getFullYear()}
          </button>
        )}
      </div>
      {open === "profile" && <ProfileModal onClose={() => setOpen(null)} />}
      {open === "wrapped" && <WrappedModal onClose={() => setOpen(null)} />}
    </>
  );
}

function LifeHome() {
  const { activeAccount, go } = useStore();
  const recent = useRecent();
  const friends = useFriends();
  const [creating, setCreating] = useState(false);
  const hero = recent[0];
  return (
    <div className="page v4-home v4-life">
      <div className="v4-main">
        <div className="v4-hi">
          {activeAccount && <Avatar account={activeAccount} size={34} />}
          <h1>{tr("Vítej zpátky", "Welcome back")}, <em>{activeAccount?.username ?? tr("hráči", "player")}</em></h1>
          <ProfileEntry />
        </div>
        <div className="v4-stage">
          <HeroBackground inst={hero} />
          {activeAccount && <span className="nametag">{activeAccount.username}</span>}
          {activeAccount ? <PlayerModel account={activeAccount} /> : null}
          <button className="v4-acct" onClick={() => go({ page: "accounts" })}>
            {activeAccount ? <Avatar account={activeAccount} size={22} /> : <Icon name="user" size={16} />}
            {activeAccount?.username ?? tr("Přidat účet", "Add account")} <Icon name="down" size={13} />
          </button>
          <div className="v4-tools">
            <button title={tr("Skiny a pláště", "Skins and capes")} onClick={() => go({ page: "accounts" })}><Icon name="shirt" size={16} /></button>
            <button title={tr("Pozadí", "Background")} onClick={() => go({ page: "settings", tab: "appearance" })}><Icon name="image" size={16} /></button>
          </div>
        </div>
        <Stats friends={friends} />
        <div className="v4-list">
          {recent.slice(0, 4).map((i) => (
            <InstanceRow key={i.id} inst={i} />
          ))}
          {!recent.length && (
            <button className="v4-empty" onClick={() => setCreating(true)}>
              <Icon name="plus" size={18} /> {tr("Vytvoř svou první instanci", "Create your first instance")}
            </button>
          )}
        </div>
      </div>
      <aside className="v4-aside">
        {QUICK_SERVERS.map((s) => (
          <ServerBanner key={s.id} server={s} />
        ))}
        <button className="v4-ban add" onClick={() => go({ page: "servers" })}>
          <Icon name="plus" size={16} /> {tr("Další servery", "More servers")}
        </button>
        <FriendsPanel friends={friends} />
        <div className="v4-foot">
          <button className="v4-btn accent" onClick={() => go({ page: "instances" })}>
            <Icon name="box" size={15} /> {tr("Instance", "Instances")}
          </button>
          <button className="v4-btn" onClick={() => go({ page: "browse" })}>
            <Icon name="plus" size={15} /> {tr("Přidat mody", "Add mods")}
          </button>
        </div>
      </aside>
      {creating && <CreateInstance onClose={() => setCreating(false)} />}
    </div>
  );
}

// ---------- Forge ----------

function ForgeHome() {
  const { go, running, play, progress } = useStore();
  const recent = useRecent();
  const friends = useFriends();
  const [creating, setCreating] = useState(false);
  const hero = recent[0];
  const place = useLastPlace(hero?.id);
  const isRunning = !!hero && running.includes(hero.id);
  return (
    <div className="page v4-home v4-forge">
      <div className="v4-stage">
        <HeroBackground inst={hero} />
        <div className="in">
          {hero ? (
            <>
              <span className="kick"><Icon name="clock" size={14} /> {tr("Pokračovat", "Continue")}</span>
              <h2>{hero.name}</h2>
              <p>{place ? (place.kind === "server" ? tr("Server", "Server") : tr("Svět", "World")) + ` „${place.name}“ · ` : ""}{hero.lastPlayed ? fmtAgo(hero.lastPlayed) : tr("ještě nehráno", "not played yet")}</p>
              <div className="launch">
                <button disabled={!!progress[hero.id]} onClick={() => (isRunning ? api.kill(hero.id) : play(hero.id))} className={isRunning ? "stop" : ""}>
                  <Icon name={isRunning ? "stop" : "play"} size={17} /> {isRunning ? tr("ZASTAVIT", "STOP") : tr("HRÁT", "PLAY")}
                </button>
                <span className="ver" onClick={() => go({ page: "instance", id: hero.id })}>
                  {LOADER_LABEL[hero.loader] ?? hero.loader} {hero.mcVersion} <Icon name="down" size={13} />
                </span>
              </div>
            </>
          ) : (
            <>
              <h2>{tr("Vítej v Kuublu", "Welcome to Kuubl")}</h2>
              <p>{tr("Vytvoř si první instanci a hraj.", "Create your first instance and play.")}</p>
              <div className="launch"><button onClick={() => setCreating(true)}><Icon name="plus" size={17} /> {tr("NOVÁ INSTANCE", "NEW INSTANCE")}</button></div>
            </>
          )}
        </div>
        {hero && (
          <div className="meta">
            <span><Icon name="clock" size={13} /> {fmtDuration(hero.playtimeSecs || 0) || "0 min"} {tr("odehráno", "played")}</span>
          </div>
        )}
      </div>
      <div className="v4-cols">
        <div>
          <ProfileEntry />
          <div className="v4-h">{tr("Instance", "Instances")}<button className="link" onClick={() => go({ page: "instances" })}>{tr("Zobrazit vše", "Show all")}</button></div>
          <div className="v4-grid">
            {recent.slice(0, 3).map((i) => (
              <div key={i.id} className={`v4-card ${running.includes(i.id) ? "run" : ""}`} onClick={() => go({ page: "instance", id: i.id })}>
                <Thumb inst={i} className="big" />
                <div className="t">
                  <b className="ellipsis">{i.name}</b>
                  <span><em>{LOADER_LABEL[i.loader] ?? i.loader}</em> {running.includes(i.id) ? tr("běží", "running") : i.lastPlayed ? fmtAgo(i.lastPlayed) : i.mcVersion}</span>
                </div>
                <button className="qp" title={tr("Hrát", "Play")} onClick={(e) => (e.stopPropagation(), play(i.id))} disabled={running.includes(i.id) || !!progress[i.id]}>
                  <Icon name="play" size={13} />
                </button>
              </div>
            ))}
            <div className="v4-card new" onClick={() => setCreating(true)}>
              <Icon name="plus" size={20} />
              <span>{tr("Nová instance", "New instance")}</span>
            </div>
          </div>
        </div>
        <div>
          <FriendsPanel friends={friends} />
          <div className="v4-srvs">
            {QUICK_SERVERS.map((s) => (
              <ServerBanner key={s.id} server={s} />
            ))}
          </div>
        </div>
      </div>
      {creating && <CreateInstance onClose={() => setCreating(false)} />}
    </div>
  );
}

// ---------- Arcade ----------

function ArcadeHome() {
  const { go, running, play, progress } = useStore();
  const recent = useRecent();
  const [creating, setCreating] = useState(false);
  const hero = recent[0];
  const place = useLastPlace(hero?.id);
  const isRunning = !!hero && running.includes(hero.id);
  const prev = useRef(isRunning);
  useEffect(() => {
    if (hero && !isRunning && prev.current) forgetPlace(hero.id);
    prev.current = isRunning;
  }, [isRunning]);
  return (
    <div className="page v4-home v4-arcade">
      <div className="v4-stage">
        <HeroBackground inst={hero} />
        <div className="in">
          <span className="lbl">{hero ? tr("Pokračovat", "Continue") : tr("Začni hrát", "Start playing")}</span>
          <h1>{hero?.name ?? "Kuubl"}</h1>
          <p>{hero ? `${LOADER_LABEL[hero.loader] ?? hero.loader} ${hero.mcVersion}${place ? ` · „${place.name}“` : ""} · ${hero.lastPlayed ? fmtAgo(hero.lastPlayed) : tr("nehráno", "not played")}` : tr("Vytvoř si první instanci.", "Create your first instance.")}</p>
          <div className="btns">
            {hero ? (
              <button className={`play ${isRunning ? "stop" : ""}`} disabled={!!progress[hero.id]} onClick={() => (isRunning ? api.kill(hero.id) : play(hero.id))}>
                <Icon name={isRunning ? "stop" : "play"} size={19} /> {isRunning ? tr("ZASTAVIT", "STOP") : tr("HRÁT", "PLAY")}
              </button>
            ) : (
              <button className="play" onClick={() => setCreating(true)}><Icon name="plus" size={19} /> {tr("NOVÁ INSTANCE", "NEW INSTANCE")}</button>
            )}
            {hero && (
              <button className="sec" onClick={() => go({ page: "instance", id: hero.id })}>
                <Icon name="settings" size={16} /> {tr("Instance", "Instance")}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="v4-shelf">
        <ProfileEntry />
        <div className="v4-h">{tr("Tvoje instance", "Your instances")}<button className="link" onClick={() => go({ page: "instances" })}>{tr("Vše", "All")}</button></div>
        <div className="row">
          {recent.slice(0, 4).map((i) => (
            <div key={i.id} className={`tile ${running.includes(i.id) ? "run" : ""}`} onClick={() => go({ page: "instance", id: i.id })}>
              <Thumb inst={i} className="fill" />
              <div className="t">
                <b className="ellipsis">{i.name}</b>
                <span>{running.includes(i.id) ? tr("Běží", "Running") : `${LOADER_LABEL[i.loader] ?? i.loader} · ${i.lastPlayed ? fmtAgo(i.lastPlayed) : i.mcVersion}`}</span>
              </div>
            </div>
          ))}
          <div className="tile add" onClick={() => setCreating(true)}>
            <Icon name="plus" size={24} />
            <span>{tr("Nová instance", "New instance")}</span>
          </div>
        </div>
      </div>
      {creating && <CreateInstance onClose={() => setCreating(false)} />}
    </div>
  );
}

export default function HomeV4({ design }: { design: Exclude<Design, "classic"> }) {
  if (design === "forge") return <ForgeHome />;
  if (design === "arcade") return <ArcadeHome />;
  return <LifeHome />;
}
