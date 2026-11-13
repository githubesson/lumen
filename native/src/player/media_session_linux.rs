//! Linux desktop integration. All commands return through the existing UI channel.
use super::{Button, Shown, Update};
use crate::net::LateWaker;
use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    mpsc::{Sender, channel},
};
use zbus::blocking::{Connection, connection::Builder};
use zbus::zvariant::{ObjectPath, OwnedValue, Value};

const PATH: &str = "/org/mpris/MediaPlayer2";
struct Root;
#[zbus::interface(name = "org.mpris.MediaPlayer2")]
impl Root {
    #[zbus(property)]
    fn identity(&self) -> &str {
        "Lumen"
    }
    #[zbus(property)]
    fn desktop_entry(&self) -> &str {
        "lumen"
    }
    #[zbus(property)]
    fn can_quit(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn can_raise(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn has_track_list(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn supported_uri_schemes(&self) -> Vec<String> {
        vec![]
    }
    #[zbus(property)]
    fn supported_mime_types(&self) -> Vec<String> {
        vec![]
    }
}

#[derive(Default)]
struct State {
    shown: Shown,
    track_id: u64,
    art_url: Option<String>,
    sampled_at: Option<std::time::Instant>,
}
impl State {
    fn position(&self) -> i64 {
        if self.shown.track.is_none() { return 0; }
        // Not while it waits for audio (buffering).
        let elapsed = if self.shown.running {
            self.sampled_at.map(|at| at.elapsed().as_micros().min(i64::MAX as u128) as i64).unwrap_or(0)
        } else { 0 };
        let at = self.shown.position_us.saturating_add(elapsed).max(0);
        if self.shown.duration_us > 0 { at.min(self.shown.duration_us) } else { at }
    }
}
struct Player {
    state: Arc<Mutex<State>>,
    buttons: Sender<Button>,
    waker: LateWaker,
}
impl Player {
    fn send(&self, button: Button) {
        if self.state.lock().unwrap().shown.track.is_some() {
            let _ = self.buttons.send(button);
            self.waker.wake();
        }
    }
}
#[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
impl Player {
    fn play(&self) {
        self.send(Button::Play);
    }
    fn pause(&self) {
        self.send(Button::Pause);
    }
    fn play_pause(&self) {
        let playing = self.state.lock().unwrap().shown.playing;
        self.send(if playing { Button::Pause } else { Button::Play });
    }
    fn next(&self) {
        self.send(Button::Next);
    }
    fn previous(&self) {
        self.send(Button::Previous);
    }
    #[zbus(property)]
    fn playback_status(&self) -> String {
        let s = self.state.lock().unwrap();
        status(&s.shown).into()
    }
    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, OwnedValue> {
        metadata(&self.state.lock().unwrap())
    }
    #[zbus(property(emits_changed_signal = "false"))]
    fn position(&self) -> i64 {
        self.state.lock().unwrap().position()
    }
    #[zbus(property)]
    fn rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn minimum_rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn maximum_rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn can_control(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_play(&self) -> bool {
        self.state.lock().unwrap().shown.track.is_some()
    }
    #[zbus(property)]
    fn can_pause(&self) -> bool {
        self.can_play()
    }
    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        self.can_play()
    }
    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        self.can_play()
    }
    #[zbus(property)]
    fn can_seek(&self) -> bool {
        false
    }
}
fn status(shown: &Shown) -> &'static str {
    if shown.track.is_none() {
        "Stopped"
    } else if shown.playing {
        "Playing"
    } else {
        "Paused"
    }
}
fn metadata(s: &State) -> HashMap<String, OwnedValue> {
    let mut m = HashMap::new();
    if let Some(t) = &s.shown.track {
        if s.shown.duration_us > 0 {
            m.insert("mpris:length".into(), OwnedValue::from(s.shown.duration_us));
        }
        let id =
            ObjectPath::try_from(format!("/org/mpris/MediaPlayer2/track/{}", s.track_id)).unwrap();
        m.insert("mpris:trackid".into(), Value::from(id).try_into().unwrap());
        m.insert(
            "xesam:title".into(),
            Value::from(t.title.clone()).try_into().unwrap(),
        );
        if let Some(a) = &t.artist {
            m.insert(
                "xesam:artist".into(),
                Value::from(vec![a.clone()]).try_into().unwrap(),
            );
        }
        if let Some(a) = &t.album {
            m.insert(
                "xesam:album".into(),
                Value::from(a.clone()).try_into().unwrap(),
            );
        }
        if let Some(art) = &s.art_url {
            m.insert(
                "mpris:artUrl".into(),
                Value::from(art.clone()).try_into().unwrap(),
            );
        }
    }
    m
}

// Fetch authenticated covers ourselves: desktop consumers cannot send Lumen's
// session cookie. Publish only a local PNG URL, never credentials or signed URLs.
struct ArtJob {
    revision: u64,
    path: String,
    client: crate::api::Client,
}
struct ArtCache(std::path::PathBuf);
const ART_PREFIX: &str = "lumen-mpris-art-";
impl ArtCache {
    fn new() -> std::io::Result<Self> {
        use std::os::unix::fs::DirBuilderExt;
        let base = match dirs::runtime_dir() {
            Some(dir) => {
                // A worker thread's Drop doesn't run at exit; the next start clears
                // what a gone process left (only in the user's own runtime dir).
                sweep(&dir, |pid| std::path::Path::new(&format!("/proc/{pid}")).exists());
                dir
            }
            None => std::env::temp_dir(),
        };
        let name = format!("{ART_PREFIX}{}-{}", std::process::id(), uuid::Uuid::new_v4());
        let path = base.join(name);
        std::fs::DirBuilder::new().mode(0o700).create(&path)?;
        Ok(Self(path))
    }
    fn store(&self, revision: u64, bytes: &[u8]) -> Option<String> {
        let image = image::load_from_memory(bytes).ok()?.thumbnail(512, 512);
        let path = self.0.join(format!("{revision}.png"));
        image
            .save_with_format(&path, image::ImageFormat::Png)
            .ok()?;
        // Keep the current and previous file for consumers still finishing a
        // read during a track transition; do not accumulate a whole library.
        if let Ok(entries) = std::fs::read_dir(&self.0) {
            for entry in entries.flatten() {
                let old = entry
                    .path()
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(|s| s.parse::<u64>().ok());
                if old.is_some_and(|n| n.saturating_add(1) < revision) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        Some(url::Url::from_file_path(path).ok()?.to_string())
    }
}
impl Drop for ArtCache {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
/// Removes the cover caches in `base` whose process isn't `alive` any more.
fn sweep(base: &std::path::Path, alive: impl Fn(u32) -> bool) {
    let Ok(entries) = std::fs::read_dir(base) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let pid = name.to_str().and_then(|n| n.strip_prefix(ART_PREFIX)).and_then(|n| n.split('-').next()).and_then(|p| p.parse().ok());
        // `file_type` doesn't follow a symlink.
        if pid.is_some_and(|pid| !alive(pid)) && entry.file_type().is_ok_and(|t| t.is_dir()) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}
fn art_worker(
    state: Arc<Mutex<State>>,
    connection: Connection,
    publishing: Arc<Mutex<()>>,
) -> Option<Sender<ArtJob>> {
    let (tx, rx) = channel::<ArtJob>();
    let cache = ArtCache::new().ok()?;
    std::thread::Builder::new()
        .name("lumen-mpris-art".into())
        .spawn(move || {
            while let Ok(mut job) = rx.recv() {
                // Skip superseded queued covers; playback updates never wait on HTTP.
                while let Ok(newer) = rx.try_recv() {
                    job = newer;
                }
                if state.lock().unwrap().track_id != job.revision {
                    continue;
                }
                let art = job
                    .client
                    .bytes(&job.client.url(&job.path))
                    .ok()
                    .and_then(|(bytes, _)| cache.store(job.revision, &bytes));
                let _publishing = publishing.lock().unwrap();
                let mut s = state.lock().unwrap();
                if s.track_id != job.revision {
                    continue;
                }
                s.art_url = art;
                let changed =
                    HashMap::from([("Metadata", Value::from(metadata(&s)).try_into().unwrap())]);
                let changed: HashMap<&str, OwnedValue> = changed;
                drop(s);
                // Serialize signals without holding the property state lock: zbus
                // must still be able to answer concurrent property reads.
                let _ = connection.emit_signal(
                    None::<&str>,
                    PATH,
                    "org.freedesktop.DBus.Properties",
                    "PropertiesChanged",
                    &(
                        "org.mpris.MediaPlayer2.Player",
                        changed,
                        Vec::<String>::new(),
                    ),
                );
            }
        })
        .ok()?;
    Some(tx)
}
fn connect(
    state: Arc<Mutex<State>>,
    buttons: Sender<Button>,
    waker: LateWaker,
) -> zbus::Result<Connection> {
    Builder::session()?
        .name(format!(
            "org.mpris.MediaPlayer2.lumen.instance{}",
            std::process::id()
        ))?
        .serve_at(PATH, Root)?
        .serve_at(
            PATH,
            Player {
                state,
                buttons,
                waker,
            },
        )?
        .build()
}
pub(super) fn start(buttons: Sender<Button>, waker: LateWaker) -> Option<Sender<Update>> {
    let (tx, rx) = channel();
    std::thread::Builder::new()
        .name("lumen-mpris".into())
        .spawn(move || {
            let state = Arc::new(Mutex::new(State::default()));
            let connection = match connect(state.clone(), buttons, waker) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Lumen MPRIS unavailable: {e}");
                    return;
                }
            };
            let publishing = Arc::new(Mutex::new(()));
            let art = art_worker(state.clone(), connection.clone(), publishing.clone());
            for Update::Show(shown, client) in rx {
                let _publishing = publishing.lock().unwrap();
                let mut s = state.lock().unwrap();
                let new_track = s.shown.track != shown.track;
                let metadata_changed = new_track || s.shown.duration_us != shown.duration_us;
                let status_changed = status(&s.shown) != status(&shown);
                // Ordinary progress is read through Position. Notify consumers on
                // discontinuities, including native seeks and buffering corrections.
                let seeked = !new_track && (s.position() - shown.position_us).abs() >= 500_000;
                if new_track {
                    s.track_id += 1;
                    s.art_url = None;
                }
                s.shown = shown;
                s.sampled_at = Some(std::time::Instant::now());
                let job = if new_track {
                    s.shown
                        .track
                        .as_ref()
                        .zip(client)
                        .filter(|(t, _)| !t.artwork.is_empty())
                        .map(|(t, client)| ArtJob {
                            revision: s.track_id,
                            path: t.artwork.clone(),
                            client,
                        })
                } else {
                    None
                };
                let mut changed: HashMap<String, OwnedValue> = HashMap::new();
                if status_changed { changed.insert(
                    "PlaybackStatus".into(),
                    Value::from(status(&s.shown)).try_into().unwrap(),
                ); }
                if metadata_changed { changed.insert(
                    "Metadata".into(),
                    Value::from(metadata(&s)).try_into().unwrap(),
                ); }
                if new_track { for key in ["CanPlay", "CanPause", "CanGoNext", "CanGoPrevious"] {
                    changed.insert(key.into(), OwnedValue::from(s.shown.track.is_some()));
                } }
                let position = s.position();
                drop(s);
                if !changed.is_empty() { if let Err(e) = connection.emit_signal(
                    None::<&str>,
                    PATH,
                    "org.freedesktop.DBus.Properties",
                    "PropertiesChanged",
                    &(
                        "org.mpris.MediaPlayer2.Player",
                        changed,
                        Vec::<String>::new(),
                    ),
                ) {
                    eprintln!("Lumen MPRIS update failed: {e}");
                } }
                if seeked {
                    let _ = connection.emit_signal(None::<&str>, PATH,
                        "org.mpris.MediaPlayer2.Player", "Seeked", &(position,));
                }
                if let (Some(tx), Some(job)) = (&art, job) {
                    let _ = tx.send(job);
                }
            }
        })
        .ok()?;
    Some(tx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::TrackListItem;
    use std::time::Duration;

    // Run on a private real bus: dbus-run-session -- cargo test mpris_roundtrip -- --ignored
    #[test]
    #[ignore = "requires a disposable session bus"]
    fn mpris_roundtrip() {
        use crate::api::testing::{MockServer, Res};
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(800, 600)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let server = MockServer::start(vec![
            Res::new(200)
                .header("Content-Type", "image/png")
                .bytes(png.into_inner())
                .delay(Duration::from_millis(100)),
        ]);
        let (buttons, presses) = channel();
        let tx = start(buttons, LateWaker::default()).unwrap();
        let bus = Connection::session().unwrap();
        let name = format!(
            "org.mpris.MediaPlayer2.lumen.instance{}",
            std::process::id()
        );
        let proxy: zbus::blocking::Proxy =
            zbus::blocking::proxy::Builder::new(&bus)
                .destination(name.as_str()).unwrap()
                .path(PATH).unwrap()
                .interface("org.mpris.MediaPlayer2.Player").unwrap()
                .cache_properties(zbus::proxy::CacheProperties::No)
                .build().unwrap();
        let track = super::super::now_playing(&TrackListItem {
            id: "test".into(),
            title: "A & B".into(),
            artist: Some("Artist".into()),
            ..Default::default()
        });
        tx.send(Update::Show(
            Shown {
                track: Some(track.clone()),
                playing: true,
                running: true,
                position_us: 12_000_000,
                duration_us: 120_000_000,
            },
            Some(server.client()),
        ))
        .unwrap();
        for n in 0..100 {
            if proxy
                .get_property::<String>("PlaybackStatus")
                .ok()
                .as_deref()
                == Some("Playing")
            {
                break;
            }
            assert!(n < 99, "MPRIS never published playback");
            std::thread::sleep(Duration::from_millis(20));
        }
        let m: HashMap<String, OwnedValue> = proxy.get_property("Metadata").unwrap();
        assert_eq!(<&str>::try_from(&m["xesam:title"]).unwrap(), "A & B");
        assert_eq!(i64::try_from(&m["mpris:length"]).unwrap(), 120_000_000);
        let first: i64 = proxy.get_property("Position").unwrap();
        assert!((12_000_000..13_000_000).contains(&first));
        std::thread::sleep(Duration::from_millis(100));
        assert!(proxy.get_property::<i64>("Position").unwrap() > first);
        let mut art_path = None;
        for n in 0..100 {
            let m: HashMap<String, OwnedValue> = proxy.get_property("Metadata").unwrap();
            if let Some(value) = m.get("mpris:artUrl") {
                let uri = <&str>::try_from(value).unwrap();
                assert!(uri.starts_with("file://"));
                let path = url::Url::parse(uri).unwrap().to_file_path().unwrap();
                let img = image::open(&path).unwrap();
                assert_eq!((img.width(), img.height()), (512, 384));
                art_path = Some(path);
                break;
            }
            assert!(n < 99, "cover never published");
            std::thread::sleep(Duration::from_millis(20));
        }
        for (method, expected) in [
            ("Pause", Button::Pause),
            ("Play", Button::Play),
            ("Next", Button::Next),
            ("Previous", Button::Previous),
            ("PlayPause", Button::Pause),
        ] {
            proxy.call::<_, _, ()>(method, &()).unwrap();
            assert_eq!(
                presses.recv_timeout(Duration::from_secs(1)).unwrap(),
                expected
            );
        }
        tx.send(Update::Show(
            Shown {
                track: Some(track),
                playing: false,
                running: false,
                position_us: 45_000_000,
                duration_us: 120_000_000,
            },
            None,
        ))
        .unwrap();
        for n in 0..100 {
            if proxy.get_property::<String>("PlaybackStatus").unwrap() == "Paused" {
                break;
            }
            assert!(n < 99);
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(proxy.get_property::<i64>("Position").unwrap(), 45_000_000);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(proxy.get_property::<i64>("Position").unwrap(), 45_000_000);
        proxy.call::<_, _, ()>("PlayPause", &()).unwrap();
        assert_eq!(
            presses.recv_timeout(Duration::from_secs(1)).unwrap(),
            Button::Play
        );
        // A new track without a usable cover must not inherit the old image.
        let mut uncovered = super::super::now_playing(&TrackListItem {
            id: "no-cover".into(),
            title: "No cover".into(),
            ..Default::default()
        });
        uncovered.artwork.clear();
        tx.send(Update::Show(
            Shown {
                track: Some(uncovered),
                playing: true,
                running: true,
                position_us: 12_000_000,
                duration_us: 120_000_000,
            },
            None,
        ))
        .unwrap();
        for n in 0..100 {
            let m: HashMap<String, OwnedValue> = proxy.get_property("Metadata").unwrap();
            if m.get("xesam:title").and_then(|v| <&str>::try_from(v).ok()) == Some("No cover") {
                assert!(!m.contains_key("mpris:artUrl"));
                break;
            }
            assert!(n < 99);
            std::thread::sleep(Duration::from_millis(20));
        }
        tx.send(Update::Show(Shown::default(), None)).unwrap();
        for n in 0..100 {
            if proxy.get_property::<String>("PlaybackStatus").unwrap() == "Stopped" {
                break;
            }
            assert!(n < 99);
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            proxy
                .get_property::<HashMap<String, OwnedValue>>("Metadata")
                .unwrap()
                .is_empty()
        );
        assert!(!proxy.get_property::<bool>("CanPlay").unwrap());
        proxy.call::<_, _, ()>("Next", &()).unwrap();
        assert!(presses.recv_timeout(Duration::from_millis(100)).is_err());
        drop(tx);
        for n in 0..100 {
            if !art_path.as_ref().unwrap().exists() {
                break;
            }
            assert!(n < 99, "private cover cache not removed on shutdown");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn mpris_cover_rejects_invalid_data_and_cleans_cache() {
        let cache = ArtCache::new().unwrap();
        let path = cache.0.clone();
        assert!(cache.store(1, b"<html>not a cover</html>").is_none());
        drop(cache);
        assert!(!path.exists());
    }

    #[test]
    fn mpris_covers_left_by_a_gone_process_are_cleared() {
        let base = std::env::temp_dir().join(format!("lumen-mpris-sweep-{}", uuid::Uuid::new_v4()));
        let dir = |name: &str| {
            let p = base.join(name);
            std::fs::create_dir_all(&p).unwrap();
            std::fs::write(p.join("1.png"), b"x").unwrap();
            p
        };
        let (gone, alive, other) = (dir("lumen-mpris-art-41-a"), dir("lumen-mpris-art-42-b"), dir("something-else"));
        sweep(&base, |pid| pid == 42);
        assert!(!gone.exists() && alive.exists() && other.exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
