//! Play sessions, one JSON line per game run (`<data>/history.jsonl`), for the player profile and
//! Kuubl Wrapped. Older play time only exists as the per-instance total (Instance::playtime_secs).

use crate::settings;
use serde::{Deserialize, Serialize};
use std::io::Write;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub instance: String,
    pub name: String,
    pub mc: String,
    pub loader: String,
    /// "server" | "world" | "" (unknown)
    pub place_kind: String,
    pub place: String,
    /// Unix seconds when the game started.
    pub start: i64,
    pub secs: u64,
}

fn path() -> std::path::PathBuf {
    settings::data_dir().join("history.jsonl")
}

pub fn record(s: &Session) {
    let line = match serde_json::to_string(s) {
        Ok(l) => l,
        Err(_) => return,
    };
    let res = std::fs::OpenOptions::new().create(true).append(true).open(path()).and_then(|mut f| writeln!(f, "{line}"));
    if let Err(e) = res {
        lwarn!("history: {e}");
    }
}

/// Every recorded session, oldest first; broken lines are skipped.
pub fn all() -> Vec<Session> {
    parse(&std::fs::read_to_string(path()).unwrap_or_default())
}

fn parse(text: &str) -> Vec<Session> {
    text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

#[tauri::command]
pub fn play_history() -> Vec<Session> {
    all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_broken_lines() {
        let s = Session { instance: "a".into(), name: "A".into(), mc: "1.21.11".into(), loader: "fabric".into(), place_kind: "server".into(), place: "justicesmp.online".into(), start: 1, secs: 60 };
        let text = format!("{}\nnot json\n\n{}\n", serde_json::to_string(&s).unwrap(), serde_json::to_string(&s).unwrap());
        assert_eq!(parse(&text), vec![s.clone(), s]);
    }
}
