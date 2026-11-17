//! One-time move from the old "Justice Client" names to "Kuubl Client".
//!
//! Runs before anything reads settings: renames the config folder, the data folder (when it still
//! has the default name), the clips folder and the WebView profile, and rewrites stored paths.
//! Every step is skipped when the new location already exists or the old one is in use, so a
//! failed rename never loses data: the launcher just keeps using the old folder.

use std::path::{Path, PathBuf};

const OLD_DIR: &str = "JusticeClient";
const NEW_DIR: &str = "KuublClient";
const OLD_ID: &str = "cz.justice.client";
const NEW_ID: &str = "cz.kuubl.client";
const OLD_CLIPS: &str = "Justice Clips";
const NEW_CLIPS: &str = "Kuubl Clips";
const OLD_RED: &str = "#e11d38";
const NEW_ACCENT: &str = "#f0661f";

/// Renames `from` to `to`, retrying briefly (the old launcher or its WebView may still be closing).
fn rename(from: &Path, to: &Path) -> bool {
    if !from.exists() || to.exists() {
        return false;
    }
    for _ in 0..10 {
        if std::fs::rename(from, to).is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    false
}

/// Replaces a stored path in a JSON file, both raw and JSON-escaped (Windows backslashes).
fn rewrite(file: &Path, old: &str, new: &str) {
    let Ok(text) = std::fs::read_to_string(file) else { return };
    let esc = |s: &str| s.replace('\\', "\\\\");
    let out = text.replace(&esc(old), &esc(new)).replace(old, new);
    if out != text {
        let _ = std::fs::write(file, out);
    }
}

fn json_files(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|d| d.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect())
        .unwrap_or_default()
}

/// Moves a folder named `JusticeClient` next to itself as `KuublClient` and fixes paths that
/// point into it. Returns the folder that is in use afterwards.
fn move_data_dir(old: &Path, config: &Path) -> PathBuf {
    if old.file_name().is_none_or(|n| n != OLD_DIR) {
        return old.to_path_buf();
    }
    let new = old.with_file_name(NEW_DIR);
    if !(rename(old, &new) || (!old.exists() && new.exists())) {
        return old.to_path_buf();
    }
    let (o, n) = (old.to_string_lossy().into_owned(), new.to_string_lossy().into_owned());
    for f in json_files(config).into_iter().chain(json_files(&new)) {
        rewrite(&f, &o, &n);
    }
    if let Ok(dirs) = std::fs::read_dir(new.join("instances")) {
        for d in dirs.flatten() {
            for f in json_files(&d.path()) {
                rewrite(&f, &o, &n);
            }
        }
    }
    new
}

pub fn run() {
    // Tests on a machine that still runs the old launcher must not move its folders.
    if std::env::var_os("KUUBL_NO_MIGRATE").is_some() {
        return;
    }
    let Some(config_root) = dirs::config_dir() else { return };
    let config = config_root.join(NEW_DIR);
    let old_config = config_root.join(OLD_DIR);
    // On Windows the config and the default data folder are the same (%APPDATA%\JusticeClient).
    let config_moved = rename(&old_config, &config);
    if config_moved {
        let (o, n) = (old_config.to_string_lossy().into_owned(), config.to_string_lossy().into_owned());
        for f in json_files(&config) {
            rewrite(&f, &o, &n);
        }
    }

    // Data folder: settings.json keeps its path.
    let settings_file = config.join("settings.json");
    if let Ok(text) = std::fs::read_to_string(&settings_file) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(dir) = v.get("dataDir").and_then(|d| d.as_str()).filter(|d| !d.is_empty()) {
                move_data_dir(Path::new(dir), &config);
            }
        }
        // The default accent was red; the new brand is orange.
        rewrite(&settings_file, &format!("\"{OLD_RED}\""), &format!("\"{NEW_ACCENT}\""));
    }
    // Linux keeps data apart from config (~/.local/share/JusticeClient).
    if let Some(data_root) = dirs::data_dir() {
        if data_root != config_root {
            move_data_dir(&data_root.join(OLD_DIR), &config);
        }
    }

    // Clips folder (default "D:\Justice Clips" or "~/Videos/Justice Clips").
    let clips_file = config.join("clips.json");
    if let Ok(text) = std::fs::read_to_string(&clips_file) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(dir) = v.get("clipsDir").or_else(|| v.get("clips_dir")).and_then(|d| d.as_str()) {
                let old = PathBuf::from(dir);
                if old.file_name().is_some_and(|n| n == OLD_CLIPS) {
                    let new = old.with_file_name(NEW_CLIPS);
                    if rename(&old, &new) || (!old.exists() && new.exists()) {
                        rewrite(&clips_file, dir, &new.to_string_lossy());
                    }
                }
            }
        }
    }

    // WebView profile (localStorage: secrets, UI state) lives under the app identifier.
    for root in [dirs::data_local_dir(), dirs::data_dir()].into_iter().flatten() {
        rename(&root.join(OLD_ID), &root.join(NEW_ID));
    }
}

/// Per-instance leftovers from Justice Mod, fixed right before each launch.
pub fn instance(game_dir: &Path) {
    if std::env::var_os("KUUBL_NO_MIGRATE").is_some() && std::env::var_os("KUUBL_MIGRATE_INSTANCE").is_none() {
        return;
    }
    rename(&game_dir.join(".justice"), &game_dir.join(".kuubl"));
    let cfg = game_dir.join("config");
    rename(&cfg.join("justicemod.json"), &cfg.join("kuubl.json"));
    for f in ["justicemod-bridge.json", "justicemod-launcher.json"] {
        let _ = std::fs::remove_file(cfg.join(f));
    }
    // The old jar would load next to the new one and clash (same classes, other mod id).
    let _ = std::fs::remove_file(game_dir.join("mods").join("justice-mod.jar"));
    // Key bindings keep their keys under the new names.
    let opts = game_dir.join("options.txt");
    if let Ok(text) = std::fs::read_to_string(&opts) {
        if text.contains("justicemod") {
            let _ = std::fs::write(&opts, text.replace("key.justicemod.", "key.kuubl.").replace("key.category.justicemod.", "key.category.kuubl."));
        }
    }
}
