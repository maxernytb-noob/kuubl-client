import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type GameVersion, type Instance, type LunarProfile } from "../api";
import { Icon } from "../icons";
import { tr } from "../i18n";
import Select from "./Select";

/** Fabric mods in Lunar exist from 1.16.5; older profiles (1.8.9 PvP) use Lunar's own mods only. */
function fabricOk(v: string) {
  const m = v.match(/^1\.(\d+)/);
  return !m || Number(m[1]) >= 16;
}

/** "From Lunar Client": the Fabric mod profiles found in ~/.lunarclient, or any mods folder picked by hand. */
export default function LunarImport({ versions, busy, run }: { versions: GameVersion[]; busy: boolean; run: (f: () => Promise<Instance>) => void }) {
  const [profiles, setProfiles] = useState<LunarProfile[] | null>(null);
  const [mc, setMc] = useState<Record<string, string>>({});
  const releases = versions.filter((v) => v.kind === "release" && fabricOk(v.id));

  useEffect(() => {
    api.lunarProfiles().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  const pickFolder = async () => {
    const dir = await open({ directory: true, title: tr("Složka s mody z Lunar Clientu", "Lunar Client mods folder") });
    if (!dir) return;
    const path = dir as string;
    const guess = path.match(/(?:^|[\\/])(1\.\d+(?:\.\d+)?|2\d\.\d+(?:\.\d+)?)(?:[\\/]|$)/)?.[1] ?? null;
    setProfiles((p) => [{ path, name: path.split(/[\\/]/).slice(-3).join(" / "), mcVersion: guess, mods: 0 }, ...(p ?? [])]);
  };

  const versionOf = (p: LunarProfile) => mc[p.path] ?? p.mcVersion ?? "";

  return (
    <div className="card pad col">
      <b>{tr("Z Lunar Clientu", "From Lunar Client")}</b>
      <span className="muted small">
        {tr(
          "Vezme Fabric mody z profilu Lunar Clientu (a jejich nastavení) a udělá z nich instanci. Mody se najdou na Modrinthu, takže půjdou aktualizovat.",
          "Takes the Fabric mods from a Lunar Client profile (and their settings) and makes an instance. Mods are matched on Modrinth, so they can be updated.",
        )}
      </span>
      {profiles === null ? (
        <span className="muted small">{tr("Hledám profily…", "Looking for profiles…")}</span>
      ) : profiles.length === 0 ? (
        <span className="muted small">{tr("V ~/.lunarclient jsme nenašli žádné profily s mody. Vyber složku s mody ručně.", "No profiles with mods found in ~/.lunarclient. Pick a mods folder by hand.")}</span>
      ) : (
        <div className="col" style={{ gap: 8 }}>
          {profiles.map((p) => (
            <div key={p.path} className="row" style={{ gap: 10, alignItems: "center" }}>
              <Icon name="gamepad" size={16} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis">{p.name}</div>
                <div className="muted small ellipsis" title={p.path}>
                  {p.mcVersion && !fabricOk(p.mcVersion)
                    ? tr("Fabric mody jdou až od 1.16.5", "Fabric mods need 1.16.5 or newer")
                    : p.mods ? `${p.mods} ${tr("modů", "mods")}` : p.path}
                </div>
              </div>
              <Select className="select" style={{ width: 130 }} value={versionOf(p)} onChange={(e) => setMc((m) => ({ ...m, [p.path]: e.target.value }))}>
                <option value="">{tr("Verze…", "Version…")}</option>
                {p.mcVersion && !releases.some((v) => v.id === p.mcVersion) && <option value={p.mcVersion}>{p.mcVersion}</option>}
                {releases.map((v) => (
                  <option key={v.id} value={v.id}>{v.id}</option>
                ))}
              </Select>
              <button className="btn sm primary" disabled={busy || !versionOf(p) || !fabricOk(versionOf(p))} onClick={() => run(() => api.importLunar(p.path, versionOf(p), `Lunar ${versionOf(p)}`))}>
                <Icon name="download" size={14} /> {tr("Importovat", "Import")}
              </button>
            </div>
          ))}
        </div>
      )}
      <div>
        <button className="btn sm ghost" onClick={pickFolder} disabled={busy}>
          <Icon name="folder" size={14} /> {tr("Vybrat složku s mody…", "Pick a mods folder…")}
        </button>
      </div>
    </div>
  );
}
