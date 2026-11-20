import { useState } from "react";
import { Icon } from "../icons";
import { useStore } from "../store";
import { Modal, ProgressBar } from "./common";
import { tr } from "../i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { LinuxPackage } from "../api";

/** Title-bar pill that appears when a new launcher version is available, plus its dialog. */
export default function UpdatePill() {
  const { update, updateProgress, installUpdate, system } = useStore();
  const [open, setOpen] = useState(false);
  if (!update) return null;
  const installing = !!updateProgress;
  const pct = updateProgress && updateProgress.total ? Math.round((updateProgress.done / updateProgress.total) * 100) : null;

  return (
    <>
      <button className="update-pill" onClick={() => setOpen(true)}>
        <Icon name="download" size={13} /> {tr("Aktualizace", "Update")} {update.version}
      </button>
      {open && (
        <Modal
          title={
            <span className="row">
              <Icon name="sparkles" style={{ color: "var(--red)" }} /> Kuubl Client {update.version}
            </span>
          }
          onClose={() => !installing && setOpen(false)}
          footer={
            installing ? undefined : (
              <>
                <button className="btn ghost" onClick={() => setOpen(false)}>
                  {tr("Později", "Later")}
                </button>
                {update.manual && !["arch", "deb", "appimage"].includes(update.manual.kind) ? (
                  <button className="btn primary" onClick={() => openUrl(update.manual!.url)}>
                    <Icon name="download" size={16} /> {tr("Otevřít stránku ke stažení", "Open download page")}
                  </button>
                ) : (
                  <button className="btn primary" onClick={installUpdate}>
                    <Icon name="download" size={16} /> {tr("Aktualizovat a restartovat", "Update and restart")}
                  </button>
                )}
              </>
            )
          }
        >
          <div className="col">
            <div className="small muted">
              {tr("Teď máš", "You have")} {system?.version} → {update.version}
            </div>
            {update.manual && <LinuxSteps kind={update.manual.kind} />}
            {update.body && (
              <div className="card pad" style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>
                {update.body}
              </div>
            )}
            {installing && (
              <div className="col" style={{ gap: 8 }}>
                <div className="row small muted">
                  <span className="grow">{pct === 100 ? tr("Instaluji a restartuji…", "Installing and restarting…") : tr("Stahuji aktualizaci…", "Downloading update…")}</span>
                  {pct != null && <span>{pct} %</span>}
                </div>
                <ProgressBar done={updateProgress!.done} total={updateProgress!.total || 1} />
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/** How to update each Linux build: the in-app updater only replaces the Windows installer. */
function LinuxSteps({ kind }: { kind: LinuxPackage }) {
  if (kind === "appimage")
    return <div className="small muted">{tr("Launcher stáhne nový AppImage a nahradí jím ten starý. Instance a nastavení zůstanou.", "The launcher downloads the new AppImage and replaces the old one. Your instances and settings stay.")}</div>;
  if (kind === "arch" || kind === "deb")
    return <div className="small muted">{tr("Launcher stáhne nový balíček a nainstaluje ho. Systém se tě zeptá na heslo.", "The launcher downloads the new package and installs it. Your system will ask for your password.")}</div>;
  if (kind === "aur")
    return (
      <div className="small muted" style={{ userSelect: "text" }}>
        {tr("Máš launcher z AUR, aktualizuj ho svým AUR pomocníkem:", "You installed the launcher from the AUR, update it with your AUR helper:")} <code>yay -Syu kuubl-bin</code>
      </div>
    );
  return null;
}
