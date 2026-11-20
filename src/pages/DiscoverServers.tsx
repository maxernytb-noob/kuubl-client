import { useEffect, useMemo, useState } from "react";
import { api, type DiscoverList, type DiscoverServer, type Server, type ServerStatus } from "../api";
import { Icon } from "../icons";
import { errText, useStore } from "../store";
import { isEn, tr } from "../i18n";
import { Motd } from "./Servers";

const TAGS: [string, [string, string]][] = [
  ["all", ["Vše", "All"]],
  ["pvp", ["PvP", "PvP"]],
  ["minigames", ["Minihry", "Minigames"]],
  ["survival", ["Survival", "Survival"]],
  ["smp", ["SMP", "SMP"]],
  ["skyblock", ["SkyBlock", "SkyBlock"]],
  ["rpg", ["RPG", "RPG"]],
  ["prison", ["Prison", "Prison"]],
  ["anarchy", ["Anarchy", "Anarchy"]],
  ["cz", ["Česko", "Czech"]],
];

/** Pings addresses a few at a time so a long list doesn't open dozens of sockets at once. */
async function pingAll(addresses: string[], onResult: (a: string, s: ServerStatus | null) => void) {
  const queue = [...addresses];
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      try {
        onResult(a, await api.pingServer(a));
      } catch {
        onResult(a, null);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

/** "Discover servers": Justice SMP and Ertenix on top, then a searchable list of public servers. */
export default function DiscoverServers({ mine, onAdded }: { mine: Server[]; onAdded: () => void }) {
  const { instances, play, toast, settings } = useStore();
  const [list, setList] = useState<DiscoverList | null>(null);
  const [status, setStatus] = useState<Record<string, ServerStatus | null>>({});
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("all");
  const cs = !isEn();

  useEffect(() => {
    api.discoverServers().then((l) => {
      if (!l) return;
      setList(l);
      pingAll([...l.featured, ...l.servers].map((s) => s.address), (a, s) => setStatus((p) => ({ ...p, [a]: s })));
    });
  }, []);

  const shown = useMemo(() => {
    if (!list) return [];
    const needle = q.trim().toLowerCase();
    return list.servers
      .filter((s) => tag === "all" || s.tags.includes(tag))
      .filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.address.includes(needle) || s.tags.some((t) => t.includes(needle)))
      .sort((a, b) => (status[b.address]?.online ?? -1) - (status[a.address]?.online ?? -1));
  }, [list, q, tag, status]);

  const added = (s: DiscoverServer) => mine.some((m) => m.address.toLowerCase() === s.address.toLowerCase());
  const add = async (s: DiscoverServer, pinned = false) => {
    try {
      await api.saveServer({ name: s.name, address: s.address, instance: instances[0]?.id ?? "", pinned });
      toast(tr(`${s.name} přidán do tvých serverů`, `${s.name} added to your servers`), "success");
      onAdded();
    } catch (e) {
      toast(errText(e), "error");
    }
  };
  const join = (s: DiscoverServer) => {
    const own = mine.find((m) => m.address.toLowerCase() === s.address.toLowerCase());
    const inst = instances.find((i) => i.id === own?.instance) ?? instances[0];
    if (!inst) return toast(tr("Nejdřív si vytvoř instanci", "Create an instance first"), "error");
    play(inst.id, s.address);
  };
  const desc = (s: DiscoverServer) => (cs ? s.description.cs : s.description.en);
  const players = (st?: ServerStatus | null) =>
    st ? `${st.online.toLocaleString()} ${tr("online", "online")}` : st === null ? "offline" : "…";

  if (!list) {
    return <div className="muted small" style={{ padding: 24 }}>{tr("Načítám servery…", "Loading servers…")}</div>;
  }

  return (
    <div className="col" style={{ gap: 22 }}>
      <div className="disc-featured">
        {list.featured.map((s) => {
          const st = status[s.address];
          return (
            <div key={s.address} className="disc-feat" style={{ "--feat": s.accent ?? "var(--red)" } as React.CSSProperties}>
              <div className="disc-feat-top">
                <div className="disc-feat-icon">{s.icon ? <img src={s.icon} alt="" /> : st?.icon ? <img src={st.icon} alt="" /> : <Icon name="server" size={28} />}</div>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="disc-feat-label">{tr("Od nás", "Ours")}</div>
                  <b className="disc-feat-name">{s.name}</b>
                  <div className="small muted">{settings?.streamerMode ? "••••••" : s.address}</div>
                </div>
                <span className={`srv-ping ${st ? "on" : ""}`}>{players(st)}</span>
              </div>
              <p className="disc-feat-desc">{desc(s)}</p>
              <div className="disc-feat-foot">
                {s.web && (
                  <a className="btn sm ghost" href={s.web} target="_blank" rel="noreferrer">
                    <Icon name="globe" size={14} /> Web
                  </a>
                )}
                <div className="grow" />
                {added(s) ? (
                  <span className="small muted">{tr("V tvých serverech", "In your servers")}</span>
                ) : (
                  <button className="btn sm" onClick={() => add(s, true)}>
                    <Icon name="plus" size={14} /> {tr("Přidat", "Add")}
                  </button>
                )}
                <button className="btn sm primary" onClick={() => join(s)}>
                  <Icon name="play" size={12} /> {tr("Hrát", "Play")}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <div className="disc-search">
          <Icon name="search" size={15} />
          <input className="input" placeholder={tr("Hledat server…", "Search servers…")} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {TAGS.map(([t, label]) => (
            <button key={t} className={`chip-btn ${tag === t ? "on" : ""}`} onClick={() => setTag(t)}>
              {cs ? label[0] : label[1]}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="muted small">{tr("Nic jsme nenašli.", "Nothing found.")}</div>
      ) : (
        <div className="srv-grid">
          {shown.map((s) => {
            const st = status[s.address];
            return (
              <div key={s.address} className={`srv-card ${st === null ? "off" : ""}`}>
                {st?.icon && <div className="srv-bg" style={{ backgroundImage: `url("${st.icon}")` }} />}
                <div className="srv-top">
                  <div className="srv-icon">{st?.icon ? <img src={st.icon} alt="" /> : <Icon name="server" size={24} />}</div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <b className="ellipsis">{s.name}</b>
                    <div className="small muted ellipsis">{s.address}</div>
                  </div>
                  <span className={`srv-ping ${st ? "on" : ""}`}>{players(st)}</span>
                </div>
                <div className="srv-motd">{st ? <Motd text={st.motd} /> : <span className="small muted">{desc(s)}</span>}</div>
                <div className="small muted" style={{ minHeight: 18 }}>{st ? desc(s) : ""}</div>
                <div className="srv-foot">
                  <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                    {s.tags.slice(0, 3).map((t) => (
                      <span key={t} className="chip2">{TAGS.find(([k]) => k === t)?.[1][cs ? 0 : 1] ?? t}</span>
                    ))}
                  </div>
                  <div className="grow" />
                  {added(s) ? (
                    <span className="small muted" title={tr("V tvých serverech", "In your servers")}><Icon name="check" size={14} /></span>
                  ) : (
                    <button className="btn sm ghost icon" onClick={() => add(s)} title={tr("Přidat do mých serverů", "Add to my servers")}>
                      <Icon name="plus" size={15} />
                    </button>
                  )}
                  <button className="btn primary sm" onClick={() => join(s)}>
                    <Icon name="play" size={12} /> {tr("Připojit", "Join")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="muted small">
        {tr(
          "Seznam vybíráme ručně a ověřujeme, že servery běží. Za obsah cizích serverů neručíme.",
          "We pick the list by hand and check that the servers are up. We're not responsible for other servers' content.",
        )}
      </div>
    </div>
  );
}
