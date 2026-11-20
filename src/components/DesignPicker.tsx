import { useState } from "react";
import { useStore } from "../store";
import { tr } from "../i18n";
import { Icon } from "../icons";
import { uiPrefs, type Design } from "../ui";

/** The four looks with a small drawn preview each (no screenshots to download). */
export const DESIGNS: { id: Design; name: [string, string]; text: [string, string]; colors: string[] }[] = [
  { id: "life", name: ["Život", "Life"], text: ["Tvoje postava ve scéně, barvy podle akce, bannery serverů.", "Your player in a scene, colour-coded actions, server banners."], colors: ["#0b0a10", "#f0661f", "#22c55e", "#60a5fa", "#c026d3"] },
  { id: "forge", name: ["Kovárna", "Forge"], text: ["Tmavý a hutný, popisky v liště, rychlé HRÁT s verzí.", "Dark and dense, labelled sidebar, quick PLAY with the version."], colors: ["#0a0a0b", "#17171a", "#f0661f", "#85858d"] },
  { id: "arcade", name: ["Arkáda", "Arcade"], text: ["Jako obchod s hrami: navigace nahoře, velký obrázek, dlaždice.", "Like a game store: top navigation, big picture, tiles."], colors: ["#0b0c0f", "#f0661f", "#eef0f3", "#1f222b"] },
  { id: "classic", name: ["Klasický", "Classic"], text: ["Původní vzhled launcheru.", "The launcher's original look."], colors: ["#050506", "#141417", "#f0661f"] },
];

function Mini({ id }: { id: Design }) {
  // a tiny wireframe of each layout
  return (
    <span className={`dp-mini dp-${id}`}>
      <i className="nav" />
      <i className="hero" />
      <i className="a" />
      <i className="b" />
      <i className="c" />
    </span>
  );
}

export function DesignChoices({ value, onPick }: { value: Design; onPick: (d: Design) => void }) {
  return (
    <div className="dp-grid">
      {DESIGNS.map((d) => (
        <button key={d.id} className={`dp-card ${value === d.id ? "on" : ""}`} onClick={() => onPick(d.id)}>
          <Mini id={d.id} />
          <b>{tr(...d.name)}</b>
          <span>{tr(...d.text)}</span>
          {value === d.id && <span className="dp-check"><Icon name="check" size={14} /></span>}
        </button>
      ))}
    </div>
  );
}

/** Shown once (after onboarding, or after updating to the version with designs): pick a look. */
export default function DesignPicker() {
  const { settings, saveSettings } = useStore();
  const prefs = uiPrefs(settings?.ui);
  const [pick, setPick] = useState<Design>(prefs.design);
  const save = (d: Design, done: boolean) => saveSettings({ ui: { ...prefs, design: d, designPicked: done } });
  return (
    <div className="dp-overlay">
      <div className="dp-box">
        <h2>{tr("Vyber si vzhled Kuublu", "Pick how Kuubl looks")}</h2>
        <p className="muted">{tr("Kdykoli ho změníš v Nastavení → Vzhled.", "Change it any time in Settings → Appearance.")}</p>
        <DesignChoices
          value={pick}
          onPick={(d) => {
            setPick(d);
            save(d, false);
          }}
        />
        <div className="dp-foot">
          <button className="btn primary" onClick={() => save(pick, true)}>
            <Icon name="check" size={15} /> {tr("Hotovo", "Done")}
          </button>
        </div>
      </div>
    </div>
  );
}
