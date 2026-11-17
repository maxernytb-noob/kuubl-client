//! Voice clips: "Kuubl, clip that" (or Czech "Kuubl, natoč to") saves a clip, like the hotkey.
//! Offline speech recognition with Vosk restricted to a few phrases (grammar mode, cheap on CPU).
//! The Vosk library and a small model (~40 MB) are downloaded on demand into `<data>/voice`.
//! Runs only while the replay buffer runs (a game from the launcher is running) and the setting is on.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tauri::{AppHandle, Emitter, Manager};

use super::ClipsState;

const LIB_ZIP: (&str, &str) = (
    "https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win64-0.3.45.zip",
    "f1dcc9cca460630f81ea8f71794f69c80bed6556d2a4e6237b5785e1d2dff34b",
);
const MODEL_EN: (&str, &str) = (
    "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip",
    "30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498",
);
const MODEL_CS: (&str, &str) = (
    "https://alphacephei.com/vosk/models/vosk-model-small-cs-0.4-rhasspy.zip",
    "287c3bbefc8ad67b4ab9636eecef3d62acc3719990777d03e226db5a7f19fbda",
);

/// What a recognised phrase does.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Hit {
    Clip,
    Secret,
    /// A screenshot taken by Kuubl Mod in the game.
    Screenshot,
}

/// Phrases per language. Every word must be in the model's vocabulary (the small Czech model has no
/// "klip"/"ulož", hence "natoč to").
fn phrases(lang: &str) -> &'static [(&'static str, Hit)] {
    // Neither model knows "kuubl". Said aloud it is "kůbl", which the grammar matches to the nearest
    // words it has: "kůl"/"cool" (Czech) and "cool"/"kuba" (English). The old "justice" still works.
    if lang == "cs" {
        &[
            ("kůl natoč to", Hit::Clip),
            ("cool natoč to", Hit::Clip),
            ("kuba natoč to", Hit::Clip),
            ("kůl udělej fotku", Hit::Screenshot),
            ("cool udělej fotku", Hit::Screenshot),
            ("kuba udělej fotku", Hit::Screenshot),
            ("justice natoč to", Hit::Clip),
            ("justice udělej fotku", Hit::Screenshot),
        ]
    } else {
        &[
            ("cool clip that", Hit::Clip),
            ("kuba clip that", Hit::Clip),
            ("cool clip it", Hit::Clip),
            ("cool screenshot", Hit::Screenshot),
            ("kuba screenshot", Hit::Screenshot),
            ("cool take a picture", Hit::Screenshot),
            ("justice clip that", Hit::Clip),
            ("justice clip it", Hit::Clip),
            ("justice screenshot", Hit::Screenshot),
            ("justice take a picture", Hit::Screenshot),
        ]
    }
}

/// Easter-egg phrases (English model only), base64 so they aren't readable in the public source.
const SECRET_PHRASES: &[&str] = &["Y29vbCBjbGlwIG15IGRpY2sgaW50byB0aGUgd2FsbA==", "anVzdGljZSBjbGlwIG15IGRpY2sgaW50byB0aGUgd2FsbA=="];

/// All phrases for a language, including the easter egg.
fn all_phrases(lang: &str) -> Vec<(String, Hit)> {
    use base64::Engine;
    let mut out: Vec<(String, Hit)> = phrases(lang).iter().map(|(p, h)| (p.to_string(), *h)).collect();
    if lang != "cs" {
        out.extend(SECRET_PHRASES.iter().filter_map(|s| base64::engine::general_purpose::STANDARD.decode(s).ok()).filter_map(|b| String::from_utf8(b).ok()).map(|p| (p, Hit::Secret)));
    }
    out
}

pub fn dir() -> PathBuf {
    crate::settings::data_dir().join("voice")
}

fn model_dir(lang: &str) -> PathBuf {
    dir().join(if lang == "cs" { "model-cs" } else { "model-en" })
}

/// Library and the model for this language are on disk.
pub fn installed(lang: &str) -> bool {
    dir().join("libvosk.dll").is_file() && model_dir(lang).join("am").join("final.mdl").is_file()
}

// ---------------- download ----------------

async fn fetch(url: &str, sha: &str, to: &Path, progress: &(impl Fn(u64, u64) + ?Sized)) -> anyhow::Result<()> {
    use futures::StreamExt;
    use sha2::{Digest, Sha256};
    use std::io::Write;
    let r = crate::net::CLIENT.get(url).send().await?.error_for_status()?;
    let total = r.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(to)?;
    let mut hash = Sha256::new();
    let (mut done, mut stream) = (0u64, r.bytes_stream());
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        hash.update(&chunk);
        file.write_all(&chunk)?;
        done += chunk.len() as u64;
        progress(done, total);
    }
    drop(file);
    let got = hash.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
    if got != sha {
        let _ = std::fs::remove_file(to);
        anyhow::bail!("download is corrupted (checksum mismatch), try again");
    }
    Ok(())
}

/// Unpacks a zip whose entries sit in one top folder into `out` (`flat`: only the DLLs, without folders).
fn unzip(zip_path: &Path, out: &Path, flat: bool) -> anyhow::Result<()> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(zip_path)?)?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().replace('\\', "/");
        let rel = name.split_once('/').map(|(_, r)| r).unwrap_or(&name).to_string();
        if rel.is_empty() || rel.contains("..") {
            continue;
        }
        let target = if flat {
            if !rel.ends_with(".dll") {
                continue;
            }
            out.join(rel.rsplit('/').next().unwrap())
        } else {
            out.join(&rel)
        };
        if let Some(p) = target.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::io::copy(&mut f, &mut std::fs::File::create(&target)?)?;
    }
    Ok(())
}

/// Downloads what's missing for `lang`. `progress(done, total)` covers the whole download.
pub async fn install(lang: &str, progress: impl Fn(u64, u64)) -> anyhow::Result<()> {
    let d = dir();
    std::fs::create_dir_all(&d)?;
    let mut jobs: Vec<((&str, &str), PathBuf, bool, u64)> = Vec::new();
    if !d.join("libvosk.dll").is_file() {
        jobs.push((LIB_ZIP, d.clone(), true, 14_882_445));
    }
    if !model_dir(lang).join("am").join("final.mdl").is_file() {
        let (m, size) = if lang == "cs" { (MODEL_CS, 46_088_666) } else { (MODEL_EN, 41_205_931) };
        jobs.push((m, model_dir(lang), false, size));
    }
    let total: u64 = jobs.iter().map(|j| j.3).sum();
    let mut base = 0u64;
    for ((url, sha), out, flat, size) in jobs {
        let zip = d.join("download.zip");
        fetch(url, sha, &zip, &|done, _| progress(base + done, total)).await?;
        let (z, o) = (zip.clone(), out.clone());
        let tmp = if flat { o.clone() } else { o.with_extension("part") };
        let _ = if flat { Ok(()) } else { std::fs::remove_dir_all(&tmp) };
        let t2 = tmp.clone();
        tokio::task::spawn_blocking(move || unzip(&z, &t2, flat)).await??;
        if !flat {
            let _ = std::fs::remove_dir_all(&o);
            std::fs::rename(&tmp, &o)?;
        }
        let _ = std::fs::remove_file(&zip);
        base += size;
    }
    Ok(())
}

// ---------------- Vosk (loaded at runtime) ----------------

type ModelNew = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type RecNewGrm = unsafe extern "C" fn(*mut c_void, f32, *const c_char) -> *mut c_void;
type Accept = unsafe extern "C" fn(*mut c_void, *const i16, c_int) -> c_int;
type GetStr = unsafe extern "C" fn(*mut c_void) -> *const c_char;
type Free = unsafe extern "C" fn(*mut c_void);
type SetLog = unsafe extern "C" fn(c_int);
type SetWords = unsafe extern "C" fn(*mut c_void, c_int);

struct Vosk {
    _lib: libloading::Library,
    model_free: Free,
    rec_free: Free,
    accept: Accept,
    result: GetStr,
    reset: Free,
    model: *mut c_void,
    rec: *mut c_void,
}

impl Vosk {
    fn open(lang: &str) -> anyhow::Result<Vosk> {
        // LOAD_WITH_ALTERED_SEARCH_PATH: its MinGW runtime DLLs are found next to libvosk.dll.
        let lib: libloading::Library =
            unsafe { libloading::os::windows::Library::load_with_flags(dir().join("libvosk.dll"), 0x0000_0008)? }.into();
        unsafe {
            let set_log: SetLog = *lib.get(b"vosk_set_log_level\0")?;
            set_log(-1);
            let model_new: ModelNew = *lib.get(b"vosk_model_new\0")?;
            let rec_new: RecNewGrm = *lib.get(b"vosk_recognizer_new_grm\0")?;
            let path = CString::new(model_dir(lang).to_string_lossy().as_bytes())?;
            let model = model_new(path.as_ptr());
            if model.is_null() {
                anyhow::bail!("voice model failed to load");
            }
            let mut words: Vec<String> = all_phrases(lang).iter().map(|p| format!("\"{}\"", p.0)).collect();
            words.push("\"[unk]\"".into());
            let grammar = CString::new(format!("[{}]", words.join(",")))?;
            let rec = rec_new(model, 16000.0, grammar.as_ptr());
            let model_free: Free = *lib.get(b"vosk_model_free\0")?;
            if rec.is_null() {
                model_free(model);
                anyhow::bail!("voice recognizer failed to start");
            }
            // per-word confidence in final results: grammar mode squeezes any speech into the
            // phrases, so only confidently heard words count
            let set_words: SetWords = *lib.get(b"vosk_recognizer_set_words\0")?;
            set_words(rec, 1);
            Ok(Vosk {
                model_free,
                rec_free: *lib.get(b"vosk_recognizer_free\0")?,
                accept: *lib.get(b"vosk_recognizer_accept_waveform_s\0")?,
                result: *lib.get(b"vosk_recognizer_result\0")?,
                reset: *lib.get(b"vosk_recognizer_reset\0")?,
                model,
                rec,
                _lib: lib,
            })
        }
    }

    /// Feeds 16 kHz mono samples; after a finished utterance returns its words with confidences.
    fn feed(&mut self, pcm: &[i16]) -> Option<Vec<(String, f64)>> {
        unsafe {
            if (self.accept)(self.rec, pcm.as_ptr(), pcm.len() as c_int) == 0 {
                return None;
            }
            let json = CStr::from_ptr((self.result)(self.rec)).to_string_lossy();
            let v: serde_json::Value = serde_json::from_str(&json).unwrap_or_default();
            Some(
                v["result"]
                    .as_array()
                    .map(|a| a.iter().map(|w| (w["word"].as_str().unwrap_or_default().to_string(), w["conf"].as_f64().unwrap_or(0.0))).collect())
                    .unwrap_or_default(),
            )
        }
    }

    fn reset(&mut self) {
        unsafe { (self.reset)(self.rec) }
    }
}

impl Drop for Vosk {
    fn drop(&mut self) {
        unsafe {
            (self.rec_free)(self.rec);
            (self.model_free)(self.model);
        }
    }
}

/// Minimum confidence of every word of a phrase.
const MIN_CONF: f64 = 0.9;

/// The phrase said in an utterance, if any: its words in a row, each heard confidently. Other words
/// around it are fine ("okay [unk] kuubl clip that").
pub fn matched(lang: &str, words: &[(String, f64)]) -> Option<Hit> {
    // The small Czech model hears its phrases in any longer speech with full confidence, so in Czech
    // the command has to be said on its own (a pause before and after).
    let said: Vec<(String, f64)> = words.iter().filter(|(w, _)| w != "[unk]").cloned().collect();
    all_phrases(lang).iter().find_map(|(p, hit)| {
        if lang == "cs" && said.len() != p.split(' ').count() {
            return None;
        }
        let pw: Vec<&str> = p.split(' ').collect();
        words
            .windows(pw.len())
            .any(|w| w.iter().zip(&pw).all(|((word, conf), want)| word == want && *conf >= MIN_CONF))
            .then_some(*hit)
    })
}

// ---------------- microphone -> recognizer ----------------

/// Mono 16 kHz i16 from any input format/rate (linear resampling).
struct Resampler {
    step: f64,
    pos: f64,
    prev: f32,
}

impl Resampler {
    fn push(&mut self, mono: &[f32], out: &mut Vec<i16>) {
        for &s in mono {
            // emit every output sample that falls between prev and s
            while self.pos <= 1.0 {
                let v = self.prev + (s - self.prev) * self.pos as f32;
                out.push((v.clamp(-1.0, 1.0) * 32767.0) as i16);
                self.pos += self.step;
            }
            self.pos -= 1.0;
            self.prev = s;
        }
    }
}

/// Recognises phrases from `pcm` until `stop`; `on_hit` runs for each one.
fn recognise(lang: &str, rx: mpsc::Receiver<Vec<i16>>, stop: &AtomicBool, mut on_hit: impl FnMut(Hit)) -> anyhow::Result<()> {
    let mut v = Vosk::open(lang)?;
    while !stop.load(Ordering::Relaxed) {
        let Ok(pcm) = rx.recv_timeout(Duration::from_millis(300)) else { continue };
        if let Some(hit) = v.feed(&pcm).and_then(|w| matched(lang, &w)) {
            v.reset();
            on_hit(hit);
        }
    }
    Ok(())
}

fn listen(app: AppHandle, lang: String, mic: String, stop: Arc<AtomicBool>) -> anyhow::Result<()> {
    let host = cpal::default_host();
    let dev = (!mic.is_empty())
        .then(|| host.input_devices().ok().and_then(|mut i| i.find(|d| d.name().ok().as_deref() == Some(mic.as_str()))))
        .flatten()
        .or_else(|| host.default_input_device())
        .ok_or_else(|| anyhow::anyhow!("no microphone"))?;
    let cfg = dev.default_input_config()?;
    let ch = cfg.channels() as usize;
    let rate = cfg.sample_rate().0 as f64;
    let (tx, rx) = mpsc::channel::<Vec<i16>>();
    let rs = Arc::new(Mutex::new(Resampler { step: rate / 16000.0, pos: 0.0, prev: 0.0 }));
    let send = move |mono: Vec<f32>| {
        let mut out = Vec::with_capacity(mono.len() / 2 + 8);
        rs.lock().unwrap().push(&mono, &mut out);
        let _ = tx.send(out);
    };
    let err = |e| lwarn!("voice mic: {e}");
    let stream = match cfg.sample_format() {
        cpal::SampleFormat::F32 => dev.build_input_stream(
            &cfg.config(),
            move |d: &[f32], _: &_| send(d.chunks(ch).map(|f| f.iter().sum::<f32>() / ch as f32).collect()),
            err,
            None,
        )?,
        cpal::SampleFormat::I16 => dev.build_input_stream(
            &cfg.config(),
            move |d: &[i16], _: &_| send(d.chunks(ch).map(|f| f.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / ch as f32).collect()),
            err,
            None,
        )?,
        f => anyhow::bail!("unsupported mic format {f:?}"),
    };
    stream.play()?;
    linfo!("voice clips: listening ({lang}, {})", dev.name().unwrap_or_default());
    let res = recognise(&lang, rx, &stop, |hit| {
        linfo!("voice clips: heard {hit:?}");
        match hit {
            // Kuubl Mod takes it (it long-polls these events)
            Hit::Screenshot => crate::social::emit(serde_json::json!({ "type": "voice", "action": "screenshot" })),
            Hit::Secret => {
                let _ = app.emit("secret-found", "clipwall");
                super::trigger_save(&app, true);
            }
            Hit::Clip => super::trigger_save(&app, true),
        }
    });
    drop(stream);
    res
}

static RUNNING: Mutex<Option<(Arc<AtomicBool>, String)>> = Mutex::new(None);

/// Starts or stops listening to match the current state (game running, setting on, files present).
pub fn sync(app: &AppHandle) {
    let Some(st) = app.try_state::<ClipsState>() else { return };
    let s = st.settings.read().unwrap().clone();
    let want = st.games.load(Ordering::SeqCst) > 0 && s.enabled && s.voice && installed(&s.voice_lang);
    let key = format!("{}|{}", s.voice_lang, s.mic_device);
    let mut run = RUNNING.lock().unwrap();
    if let Some((stop, k)) = run.as_ref() {
        if want && *k == key {
            return;
        }
        stop.store(true, Ordering::SeqCst);
        *run = None;
        linfo!("voice clips: stopped");
    }
    if !want {
        return;
    }
    let stop = Arc::new(AtomicBool::new(false));
    *run = Some((stop.clone(), key));
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = listen(app, s.voice_lang.clone(), s.mic_device.clone(), stop) {
            lwarn!("voice clips: {e}");
        }
    });
}

/// CLI check: `--voice-test <lang> <file.wav>` (16-bit PCM WAV, any rate) prints what was matched.
pub fn test_wav(lang: &str, wav: &Path) -> anyhow::Result<Vec<Hit>> {
    let data = std::fs::read(wav)?;
    let mut fmt = None;
    let mut i = 12;
    let mut samples: Vec<f32> = Vec::new();
    while i + 8 <= data.len() {
        let id = &data[i..i + 4];
        let len = u32::from_le_bytes(data[i + 4..i + 8].try_into()?) as usize;
        let body = &data[i + 8..(i + 8 + len).min(data.len())];
        if id == b"fmt " {
            fmt = Some((u16::from_le_bytes([body[2], body[3]]) as usize, u32::from_le_bytes(body[4..8].try_into()?)));
        } else if id == b"data" {
            let (ch, _) = fmt.ok_or_else(|| anyhow::anyhow!("no fmt chunk"))?;
            samples = body
                .chunks(2 * ch)
                .map(|f| f.chunks(2).map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0).sum::<f32>() / ch as f32)
                .collect();
        }
        i += 8 + len + (len & 1);
    }
    let (_, rate) = fmt.ok_or_else(|| anyhow::anyhow!("no fmt chunk"))?;
    let mut rs = Resampler { step: rate as f64 / 16000.0, pos: 0.0, prev: 0.0 };
    let (tx, rx) = mpsc::channel();
    for chunk in samples.chunks(rate as usize / 10) {
        let mut out = Vec::new();
        rs.push(chunk, &mut out);
        tx.send(out)?;
    }
    // a second of silence so the last phrase is finalised
    tx.send(vec![0i16; 16000])?;
    drop(tx);
    let mut hits = Vec::new();
    let mut v = Vosk::open(lang)?;
    while let Ok(pcm) = rx.recv() {
        if let Some(words) = v.feed(&pcm) {
            let h = matched(lang, &words);
            println!("heard: {words:?} -> {h:?}");
            hits.extend(h);
        }
    }
    Ok(hits)
}
