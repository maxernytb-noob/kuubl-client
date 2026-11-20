//! Local bridge for Kuubl Mod: a tiny HTTP server on 127.0.0.1 so the in-game chat and world
//! sharing go through the launcher (which holds the friends session). The port and a random secret
//! are written into each instance's `config/kuubl-bridge.json` at launch; every request must
//! carry the secret, so other local programs can't use it.

use crate::{social, world};
use anyhow::Result;
use once_cell::sync::OnceCell;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

static ADDR: OnceCell<(u16, String)> = OnceCell::new();

/// (port, secret) once the bridge is running.
pub fn info() -> Option<(u16, String)> {
    ADDR.get().cloned()
}

pub fn start() {
    tauri::async_runtime::spawn(async {
        let listener = match TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(l) => l,
            Err(e) => return lwarn!("bridge: cannot listen: {e}"),
        };
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        let secret = uuid::Uuid::new_v4().simple().to_string();
        let _ = ADDR.set((port, secret.clone()));
        linfo!("bridge: listening on 127.0.0.1:{port}");
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let secret = secret.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = handle(stream, &secret).await {
                    ldebug!("bridge: request failed: {e:#}");
                }
            });
        }
    });
}

async fn handle(mut s: TcpStream, secret: &str) -> Result<()> {
    // Read the head (small requests only).
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let head_end = loop {
        let n = tokio::time::timeout(Duration::from_secs(10), s.read(&mut chunk)).await??;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > 64 * 1024 {
            return Ok(());
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let (method, target) = (first.next().unwrap_or("").to_string(), first.next().unwrap_or("").to_string());
    let mut len = 0usize;
    let mut auth = String::new();
    let mut range = String::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "content-length" => len = v.trim().parse().unwrap_or(0).min(256 * 1024),
                "x-kuubl-secret" => auth = v.trim().to_string(),
                "range" => range = v.trim().to_string(),
                _ => {}
            }
        }
    }
    if method == "GET" && target.starts_with("/video?") {
        return serve_video(&mut s, &target, &range, secret).await;
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        let n = s.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let (status, reply) = if auth != secret {
        (401, json!({ "error": "bad secret" }))
    } else {
        let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        match route(&method, &target, body).await {
            Ok(v) => (200, v),
            Err(e) => (400, json!({ "error": format!("{e:#}") })),
        }
    };
    let text = reply.to_string();
    let resp = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        if status == 200 { "OK" } else { "Error" },
        text.len()
    );
    s.write_all(resp.as_bytes()).await?;
    Ok(())
}

/// Clip videos for the launcher's <video> on Linux (see clips::clips_video_url), with Range support so
/// the player can seek. The secret is in the URL because a <video> can't send headers.
async fn serve_video(s: &mut TcpStream, target: &str, range: &str, secret: &str) -> Result<()> {
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let q = |k: &str| query.split('&').find_map(|p| p.strip_prefix(&format!("{k}="))).unwrap_or("").to_string();
    let path = urlencoding::decode(&q("p")).map(|p| p.into_owned()).unwrap_or_default();
    let file = if q("k") == secret { crate::clips::servable_video(&path) } else { None };
    let Some(file) = file else {
        s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await?;
        return Ok(());
    };
    let mut f = tokio::fs::File::open(&file).await?;
    let size = f.metadata().await?.len();
    let (start, end) = parse_range(range, size).unwrap_or((0, size.saturating_sub(1)));
    let partial = !range.is_empty() && start <= end && end < size;
    let len = if size == 0 { 0 } else { end - start + 1 };
    let head = if partial {
        format!("HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{size}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n")
    } else {
        format!("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nAccept-Ranges: bytes\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n")
    };
    s.write_all(head.as_bytes()).await?;
    use tokio::io::AsyncSeekExt;
    f.seek(std::io::SeekFrom::Start(if partial { start } else { 0 })).await?;
    let mut left = if partial { len } else { size };
    let mut buf = vec![0u8; 256 * 1024];
    while left > 0 {
        let n = f.read(&mut buf[..left.min(256 * 1024) as usize]).await?;
        if n == 0 {
            break;
        }
        s.write_all(&buf[..n]).await?;
        left -= n as u64;
    }
    Ok(())
}

/// `bytes=START-[END]` or `bytes=-SUFFIX` against a file of `size` bytes.
fn parse_range(h: &str, size: u64) -> Option<(u64, u64)> {
    let r = h.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = r.split_once('-')?;
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        return Some((size.saturating_sub(n), size.checked_sub(1)?));
    }
    let start: u64 = a.parse().ok()?;
    let end = if b.is_empty() { size.checked_sub(1)? } else { b.parse::<u64>().ok()?.min(size.checked_sub(1)?) };
    Some((start, end))
}

#[cfg(test)]
mod range_tests {
    #[test]
    fn ranges() {
        use super::parse_range as p;
        assert_eq!(p("bytes=0-", 100), Some((0, 99)));
        assert_eq!(p("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(p("bytes=90-500", 100), Some((90, 99)));
        assert_eq!(p("bytes=-10", 100), Some((90, 99)));
        assert_eq!(p("", 100), None);
    }
}

async fn route(method: &str, target: &str, body: Value) -> Result<Value> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let q = |k: &str| query.split('&').find_map(|p| p.strip_prefix(&format!("{k}="))).unwrap_or("").to_string();
    Ok(match (method, path) {
        ("GET", "/state") => {
            let me = social::me();
            json!({
                "signedIn": me.is_some(),
                "uuid": me.as_ref().map(|m| m.0.clone()),
                "name": me.as_ref().map(|m| m.1.clone()),
                "world": world::hosted().map(|h| json!({ "id": h.id, "name": h.name, "direct": h.direct })),
            })
        }
        ("GET", "/friends") => social::get("/friends").await?,
        // The "Kuubl" group: update announcements (only admins post; everyone reads and likes).
        ("GET", "/announcements") => social::get("/announcements").await?,
        ("POST", "/announcements") => social::post("/announcements", json!({ "body": body["body"] })).await?,
        ("POST", "/announcements/like") => social::post(&format!("/announcements/{}/like", body["id"].as_i64().unwrap_or(0)), json!({})).await?,
        // Friend requests and blocking from the in-game friends window.
        ("POST", "/friends/request") => social::post("/friends/request", json!({ "name": body["name"] })).await?,
        ("POST", "/friends/respond") => social::post("/friends/respond", json!({ "uuid": body["uuid"], "accept": body["accept"] })).await?,
        ("POST", "/friends/remove") => social::post("/friends/remove", json!({ "uuid": body["uuid"] })).await?,
        ("POST", "/friends/block") => social::post("/friends/block", json!({ "uuid": body["uuid"] })).await?,
        // Now playing (Windows media controls) for the mod's Now Playing HUD; the cover stays in the launcher.
        ("GET", "/media") => {
            let st = tauri::async_runtime::spawn_blocking(|| crate::media::state(None, Some("*"))).await??;
            match st {
                Some(mut m) => {
                    m.thumb = None;
                    serde_json::to_value(m)?
                }
                None => json!({ "playing": false, "title": "" }),
            }
        }
        ("POST", "/media/command") => {
            let cmd = body["command"].as_str().unwrap_or_default().to_string();
            let value = body["value"].as_f64();
            tauri::async_runtime::spawn_blocking(move || crate::media::command(&cmd, value, None)).await??;
            json!({ "ok": true })
        }
        // uuid -> Kuubl cape for everyone who picked one (the mod draws them).
        ("GET", "/capes") => social::capes().await,
        // uuid -> Kuubl pet for everyone who picked one (the mod draws them).
        ("GET", "/pets") => social::pets().await,
        // uuid -> {url, slim, file?} Kuubl skins of offline players (the mod draws them).
        ("GET", "/skins") => social::skins().await,
        ("GET", "/party") => social::get("/party").await?,
        ("POST", "/party/accept") => social::post("/party/accept", json!({ "id": body["id"] })).await?,
        ("POST", "/party/decline") => social::post("/party/decline", json!({ "id": body["id"] })).await?,
        ("POST", "/party/leave") => social::post("/party/leave", json!({})).await?,
        ("POST", "/party/invite") => social::post("/party/invite", json!({ "uuid": body["uuid"] })).await?,
        ("POST", "/party/warp") => social::warp_here().await?,
        ("POST", "/presence/server") => {
            social::set_current_server(body["server"].as_str().filter(|s| !s.is_empty()));
            json!({ "ok": true })
        }
        // PvP since the mod's last report; kept as totals for the profile and leaderboard.
        ("POST", "/stats") => crate::pvp::add(&body)?,
        ("GET", p) if p.starts_with("/messages/") => social::get(p).await?,
        // Screenshots from the in-game gallery: share link (30 days on Kuubl Social), send to a friend.
        ("POST", "/shots/upload") => {
            let path = shot_path(&body)?;
            social::upload(&path).await?
        }
        ("POST", "/shots/send") => {
            let path = shot_path(&body)?;
            let up = social::upload(&path).await?;
            let name = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            social::post("/messages", json!({ "to": body["to"], "kind": "shot", "body": name, "meta": { "url": up["url"], "size": up["size"] } })).await?
        }
        // In-game clips window: my clips (thumbnails are local files the game reads), the public feed,
        // likes, and "play" which brings the launcher up on that clip.
        ("GET", "/clips/mine") => json!({ "clips": crate::clips::bridge_list() }),
        ("GET", "/clips/feed") => social::get(&format!("/clips/feed?offset={}&hashtag=&player=&mine=false", q("offset").parse::<u32>().unwrap_or(0))).await?,
        ("POST", "/clips/like") => social::post("/clips/like", json!({ "id": body["id"] })).await?,
        ("POST", "/clips/open") => {
            crate::events::emit("open-clip", json!({ "path": body["path"], "id": body["id"] }));
            if let Some(app) = crate::events::app() {
                crate::clips::show_main(app);
            }
            json!({ "ok": true })
        }
        // Wardrobe in game: skin library + apply, skins made in the in-game editor, Kuubl cape, emotes.
        ("GET", "/wardrobe") => {
            let acc = crate::auth::active_account().ok();
            let me = social::get("/me").await.unwrap_or(Value::Null);
            json!({
                "skins": crate::skinlib::list(),
                "account": acc.map(|a| json!({ "id": a.id, "name": a.username, "kind": a.kind, "uuid": a.uuid })),
                "cape": me["profile"]["cape"],
                // animated capes the player hasn't earned yet: cape -> what unlocks it
                "locked": locked_capes(&me["profile"]["achievements"]),
            })
        }
        ("POST", "/wardrobe/skin") => {
            let acc = crate::auth::active_account()?;
            let id = body["id"].as_str().unwrap_or_default();
            crate::skinlib::apply(&acc.id, id).await?;
            social::skins_changed();
            // The game shows the new skin on you right away from this file (Mojang's copy reaches
            // other players after they reload you).
            let v = crate::skinlib::list().into_iter().find(|s| s.entry.id == id);
            json!({ "ok": true, "file": v.as_ref().map(|s| s.file.clone()), "slim": v.map(|s| s.entry.variant == "slim").unwrap_or(false) })
        }
        ("POST", "/wardrobe/skin/save") => {
            use base64::Engine;
            let png = base64::engine::general_purpose::STANDARD.decode(body["png"].as_str().unwrap_or_default())?;
            let id = crate::skinlib::add_png(png, body["name"].as_str().unwrap_or("Edited skin"), body["variant"].as_str().unwrap_or("classic"))?;
            if body["apply"] == true {
                let acc = crate::auth::active_account()?;
                crate::skinlib::apply(&acc.id, &id).await?;
                social::skins_changed();
            }
            let file = crate::skinlib::list().into_iter().find(|s| s.entry.id == id).map(|s| s.file);
            json!({ "id": id, "file": file })
        }
        ("POST", "/wardrobe/cape") => {
            // PUT /me replaces the whole profile: keep everything else as it is.
            let me = social::get("/me").await?;
            let mut p = me["profile"].clone();
            if !p.is_object() {
                p = json!({});
            }
            p["cape"] = body["cape"].clone();
            social::put("/me", p).await?;
            social::capes_changed();
            json!({ "ok": true })
        }
        ("POST", "/clip/auto") => json!({ "saved": crate::clips::auto_clip(body["reason"].as_str().unwrap_or_default()) }),
        ("POST", "/emote") => {
            social::emote(body["id"].as_str().unwrap_or_default());
            json!({ "ok": true })
        }
        // A picture shared in chat: only Kuubl upload URLs open in the browser.
        ("POST", "/open-url") => {
            let url = body["url"].as_str().unwrap_or_default();
            if !(url.starts_with("https://ertenix.net/justice/u/") || url.starts_with("https://justiceclient.online/")) {
                anyhow::bail!("not a Kuubl link");
            }
            tauri_plugin_opener::open_url(url, None::<&str>)?;
            json!({ "ok": true })
        }
        ("POST", "/open-path") => {
            let path = shot_path(&body)?;
            tauri_plugin_opener::open_path(&path, None::<&str>)?;
            json!({ "ok": true })
        }
        ("POST", "/send") => {
            social::post("/messages", json!({ "to": body["to"], "kind": "text", "body": body["body"] })).await?
        }
        ("GET", "/events") => {
            let after: u64 = q("after").parse().unwrap_or(0);
            let (seq, events) = social::events_after(after, Duration::from_secs(20)).await;
            json!({ "seq": seq, "events": events })
        }
        ("POST", "/world/host") => {
            let port = body["port"].as_u64().unwrap_or(0) as u16;
            if port == 0 {
                anyhow::bail!("missing port");
            }
            world::host(port, body["name"].as_str().unwrap_or("World"), body["mc"].as_str().unwrap_or(""), body["loader"].as_str().unwrap_or("")).await?
        }
        ("POST", "/world/invite") => world::invite(body["uuid"].as_str().unwrap_or_default()).await?,
        // The game asks while a player logs into our shared world: offline Kuubl accounts skip Mojang.
        ("GET", "/world/offline-guest") => json!({ "offline": world::is_offline_guest(&q("name")) }),
        ("POST", "/world/stop") => {
            world::stop().await;
            json!({ "ok": true })
        }
        ("POST", "/world/join") => json!({ "port": world::join(body["world"].as_str().unwrap_or_default()).await? }),
        ("POST", "/open") => {
            social::open_shared_clip(body["url"].as_str().unwrap_or_default()).await?;
            json!({ "ok": true })
        }
        // Installs a modpack sent in chat. Downloading takes a while, so it runs in the background and
        // reports back as a `pack-installed` social event.
        ("POST", "/pack/install") => {
            let code = body["code"].as_str().unwrap_or_default().to_string();
            let name = body["name"].as_str().unwrap_or_default().to_string();
            if code.is_empty() {
                anyhow::bail!("missing code");
            }
            tauri::async_runtime::spawn(async move {
                let r = crate::packs::import_code(&code).await;
                if let Err(e) = &r {
                    lwarn!("bridge: modpack install failed: {e:#}");
                }
                crate::events::emit("instances-changed", ());
                social::emit(json!({
                    "type": "pack-installed",
                    "request": name,
                    "name": r.as_ref().map(|i| i.name.clone()).unwrap_or_else(|_| name.clone()),
                    "ok": r.is_ok(),
                    "error": r.err().map(|e| format!("{e:#}")),
                }));
            });
            json!({ "ok": true })
        }
        _ => anyhow::bail!("unknown endpoint {method} {path}"),
    })
}

/// A path the game sent for a screenshot action: only PNGs inside an instance's `screenshots` folder
/// (or that folder itself), so the bridge can't be used to upload or open arbitrary files.
fn shot_path(body: &serde_json::Value) -> anyhow::Result<String> {
    let raw = body["path"].as_str().unwrap_or_default();
    let p = std::fs::canonicalize(raw).map_err(|_| anyhow::anyhow!("file not found"))?;
    let root = std::fs::canonicalize(crate::settings::instances_dir()).unwrap_or_default();
    let in_shots = p.ancestors().any(|a| a.file_name().is_some_and(|n| n == "screenshots"));
    let png = p.is_dir() || p.extension().is_some_and(|e| e.eq_ignore_ascii_case("png"));
    if !p.starts_with(&root) || !in_shots || !png {
        anyhow::bail!("not a screenshot");
    }
    Ok(p.to_string_lossy().into_owned())
}

/// Capes that need an achievement (same list as Kuubl Social's CAPE_UNLOCK) the player doesn't have yet.
fn locked_capes(achievements: &Value) -> Value {
    const UNLOCK: &[(&str, &str, &str)] = &[("inferno", "kill1", "Kill your first player"), ("starfall", "clip1", "Save your first clip"), ("rainbow", "inst5", "Have 5 instances"), ("matrix", "clip25", "Save 25 clips"), ("ender", "h100", "Play 100 hours"), ("tide", "h10", "Play 10 hours"), ("heartbeat", "friend1", "Add your first friend"), ];
    let has = |a: &str| achievements.as_array().is_some_and(|l| l.iter().any(|x| x == a));
    Value::Object(UNLOCK.iter().filter(|(_, a, _)| !has(a)).map(|(c, _, t)| (c.to_string(), Value::from(*t))).collect())
}
