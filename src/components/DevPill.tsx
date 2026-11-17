import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { Icon } from "../icons";
import { useStore } from "../store";
import { Modal, ProgressBar } from "./common";
import { tr } from "../i18n";

/**
 * Microsoft accounts that see the Dev button (the owner's). Only "msa" accounts count: an offline
 * account named Maxern_ gets a different UUID (md5 of the name) and never matches.
 */
const DEV_UUIDS = ["0494ec66d9504e5d93016701417cfb8b"];

interface ChannelBuild {
  version: string;
  current: string;
  notes: string;
  date?: string;
}

const clean = (u: string) => u.replace(/-/g, "").toLowerCase();

/** "Dev" pill in the top bar: install the latest test build from justiceclient.online/dev/, or go back to stable. */
export default function DevPill() {
  const { accounts, system, toast } = useStore();
  const [open, setOpen] = useState(false);
  const [dev, setDev] = useState<ChannelBuild | null | undefined>(undefined);
  const [stable, setStable] = useState<ChannelBuild | null | undefined>(undefined);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const allowed = accounts.some((a) => a.kind === "msa" && DEV_UUIDS.includes(clean(a.uuid ?? "")));
  const [version, setVersion] = useState(system?.version ?? "");
  useEffect(() => {
    getVersion().then((v) => setVersion(v ?? ""), () => {});
  }, []);
  const isDev = (version ?? "").includes("-dev");

  const load = () => {
    setDev(undefined);
    setStable(undefined);
    invoke<ChannelBuild | null>("channel_check", { channel: "dev" }).then(setDev, () => setDev(null));
    invoke<ChannelBuild | null>("channel_check", { channel: "stable" }).then(setStable, () => setStable(null));
  };

  useEffect(() => {
    if (!open) return;
    load();
    const un = listen<[number, number | null]>("channel-progress", (e) => setProgress({ done: e.payload[0], total: e.payload[1] ?? 0 }));
    return () => {
      un.then((f) => f());
    };
  }, [open]);

  if (!allowed) return null;

  const install = async (channel: "dev" | "stable") => {
    setProgress({ done: 0, total: 0 });
    try {
      await invoke("channel_install", { channel });
    } catch (e) {
      setProgress(null);
      toast(`${tr("Instalace selhala", "Install failed")}: ${e}`, "error");
    }
  };

  return (
    <>
      <button className="update-pill dev-pill" onClick={() => setOpen(true)} title="Dev build">
        <Icon name="code" size={13} /> Dev
      </button>
      {open && (
        <Modal
          title={
            <span className="row">
              <Icon name="code" /> Dev build
            </span>
          }
          onClose={() => !progress && setOpen(false)}
        >
          <div className="col">
            <div className="small muted">
              {tr("Teď máš", "You have")} <b>{version}</b> {isDev ? "(dev build)" : "(stable)"}. {tr("Tohle tlačítko vidí jen tvůj Microsoft účet.", "Only your Microsoft account sees this button.")}
            </div>
            <div className="card pad col" style={{ gap: 8 }}>
              <div className="row">
                <b className="grow">{tr("Nejnovější dev build", "Latest dev build")}</b>
                {dev === undefined ? <span className="small muted">{tr("Hledám…", "Checking…")}</span> : dev ? <span className="small">{dev.version}</span> : <span className="small muted">{tr("Už ho máš", "You have it")}</span>}
              </div>
              {dev?.notes && <div className="small muted" style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>{dev.notes}</div>}
              <button className="btn primary" disabled={!dev || !!progress} onClick={() => install("dev")}>
                <Icon name="download" size={16} /> {tr("Nainstalovat a restartovat", "Install and restart")}
              </button>
            </div>
            {isDev && (
              <div className="card pad col" style={{ gap: 8 }}>
                <div className="row">
                  <b className="grow">{tr("Zpět na stable", "Back to stable")}</b>
                  {stable === undefined ? <span className="small muted">{tr("Hledám…", "Checking…")}</span> : stable && <span className="small">{stable.version}</span>}
                </div>
                <button className="btn ghost" disabled={!stable || !!progress} onClick={() => install("stable")}>
                  <Icon name="download" size={16} /> {tr("Nainstalovat stable", "Install stable")}
                </button>
              </div>
            )}
            {progress && (
              <div className="col" style={{ gap: 8 }}>
                <div className="row small muted">
                  <span className="grow">{progress.total > 0 && progress.done >= progress.total ? tr("Instaluji a restartuji…", "Installing and restarting…") : tr("Stahuji…", "Downloading…")}</span>
                  {progress.total > 0 && <span>{Math.round((progress.done / progress.total) * 100)} %</span>}
                </div>
                <ProgressBar done={progress.done} total={progress.total || 1} />
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
