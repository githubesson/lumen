//! Cover art: fetched with the session on a worker, decoded, and kept by URL.
//! `CoverArt` in the web app shows the muted surface (and the entity's
//! initial once a fetch fails) until the image decodes; [`Images::get_sized`]
//! gives the view what it needs to do the same.
//!
//! Covers are decoded and resized on the worker to the device pixels they're
//! drawn at (`object-fit: cover`, a Lanczos filter, as a browser's
//! high-quality downscale), so the GPU draws them 1:1: crisp, and a 48 px
//! thumbnail costs 9 KB instead of a full-size bitmap and its mips. Decoded
//! covers and encoded bytes are both bounded in bytes, least recently used
//! out first. Encoded bytes also go to a disk cache that honours the server's
//! `Cache-Control: max-age` (covers are `private, max-age=86400`), as
//! Chromium's HTTP cache does for the Electron app, so a relaunch shows Home's
//! covers at once.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rune::{Image, ImageCache};

use crate::api::Client;
use crate::net::LateWaker;

#[derive(Clone)]
enum Slot {
    Loading,
    Ready(Picture),
    Failed,
}

/// What a cover shows right now.
pub enum Cover {
    /// Fetching or decoding: the muted surface.
    Loading,
    Ready(Picture),
    /// No image: the placeholder with the entity's initial.
    Failed,
}

/// A decoded cover, ready to draw.
#[derive(Clone)]
pub struct Picture(rune::Pixels);

impl Picture {
    pub fn pixels(&self) -> &rune::Pixels {
        &self.0
    }

    /// Its size in pixels.
    pub fn size(&self) -> Option<[u32; 2]> {
        let (w, h) = self.0.size();
        (w > 0 && h > 0).then_some([w, h])
    }
}

/// Decoded covers kept in memory, in bytes of pixels: some ten screens of a
/// card grid. Past it a cover decodes again from the bytes, in memory or on
/// disk, in a few milliseconds on a worker.
const DECODED_BUDGET: usize = 32 << 20;
/// Encoded cover bytes kept in memory (to resize again for another size);
/// the disk cache keeps them all for their `max-age` anyway.
const ENCODED_BUDGET: usize = 8 << 20;
/// The disk cache's size; the oldest files go past it.
const DISK_BUDGET: u64 = 256 << 20;
/// Without a size, covers decode at most this many pixels a side.
const UNSIZED_MAX: u32 = 512;

/// A byte-bounded least-recently-used map.
struct Lru<V> {
    /// Each entry with its size and the tick it was last used at.
    map: HashMap<String, (V, usize, u64)>,
    /// Keys by the tick they were last used at, oldest first.
    order: BTreeMap<u64, String>,
    tick: u64,
    bytes: usize,
    budget: usize,
}

impl<V: Clone> Lru<V> {
    fn new(budget: usize) -> Lru<V> {
        Lru { map: HashMap::new(), order: BTreeMap::new(), tick: 0, bytes: 0, budget }
    }

    fn get(&mut self, key: &str) -> Option<V> {
        self.tick += 1;
        let (v, _, used) = self.map.get_mut(key)?;
        let k = self.order.remove(used).unwrap_or_else(|| key.to_string());
        *used = self.tick;
        self.order.insert(self.tick, k);
        Some(v.clone())
    }

    fn put(&mut self, key: String, value: V, bytes: usize) {
        self.remove(&key);
        self.tick += 1;
        self.bytes += bytes;
        self.order.insert(self.tick, key.clone());
        self.map.insert(key, (value, bytes, self.tick));
        while self.bytes > self.budget && self.order.len() > 1 {
            let Some((_, k)) = self.order.pop_first() else { break };
            if let Some((_, b, _)) = self.map.remove(&k) {
                self.bytes -= b;
            }
        }
    }

    fn remove(&mut self, key: &str) -> Option<V> {
        let (v, b, used) = self.map.remove(key)?;
        self.bytes -= b;
        self.order.remove(&used);
        Some(v)
    }

    fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
        self.bytes = 0;
    }
}

/// Workers that take the job at the back first. An urgent request goes to
/// the back: after a fast scroll the covers on screen were asked for last,
/// so they load before the rows scrolled past. A lazy one (`loading="lazy"`
/// in the web app: a cover built off screen, as a grid builds every card)
/// waits at the front, in the order asked, until it comes on screen
/// ([`Images::want_sized`] moves it to the back). Past `MAX_QUEUED` the job
/// at the front is dropped and its slot forgotten, so a cover that shows
/// again asks again.
struct Stack<J: Task = Job> {
    jobs: Mutex<VecDeque<J>>,
    ready: Condvar,
    /// Workers start with the first job, and stop with the cache.
    started: std::sync::Once,
    closed: AtomicBool,
}

/// Cover jobs waiting at most (a few screens of rows).
const MAX_QUEUED: usize = 192;
/// Cover workers: fetches mostly wait on the network (and the server on
/// TIDAL's CDN for a cover it hasn't cached), so more run than Chromium's
/// six HTTP/1.1 connections a host; over HTTP/2 it asks for every cover in
/// view at once.
const WORKERS: usize = 8;

/// A job on the [`Stack`].
trait Task: Send + 'static {
    fn run(self);
    /// Dropped unrun, past `MAX_QUEUED`.
    fn dropped(self);
    /// What it fetches, to find it again in the queue.
    fn key(&self) -> &str;
}

impl<J: Task> Stack<J> {
    fn new() -> Arc<Stack<J>> {
        Arc::new(Stack { jobs: Mutex::new(VecDeque::new()), ready: Condvar::new(), started: std::sync::Once::new(), closed: AtomicBool::new(false) })
    }

    fn start(self: &Arc<Stack<J>>) {
        for n in 0..WORKERS {
            let s = self.clone();
            std::thread::Builder::new().name(format!("lumen-img-{n}")).spawn(move || s.work()).ok();
        }
    }

    fn work(&self) {
        loop {
            let job = {
                let mut jobs = self.jobs.lock().unwrap();
                loop {
                    if self.closed.load(Ordering::Acquire) {
                        return;
                    }
                    if let Some(job) = jobs.pop_back() {
                        break job;
                    }
                    jobs = self.ready.wait(jobs).unwrap();
                }
            };
            job.run();
        }
    }

    /// Moves the waiting job for `key` to the back (next to run, `urgent`) or
    /// the front. False when none waits (running, done or dropped).
    fn reorder(&self, key: &str, urgent: bool) -> bool {
        let mut jobs = self.jobs.lock().unwrap();
        let Some(at) = jobs.iter().position(|j| j.key() == key) else { return false };
        let job = jobs.remove(at).unwrap();
        if urgent { jobs.push_back(job) } else { jobs.push_front(job) }
        true
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.jobs.lock().unwrap().clear();
        self.ready.notify_all();
    }

    /// Queues `job`: at the back when `urgent`, else at the front.
    fn push(self: &Arc<Stack<J>>, job: J, urgent: bool) {
        self.started.call_once(|| self.start());
        let dropped = {
            let mut jobs = self.jobs.lock().unwrap();
            if urgent { jobs.push_back(job) } else { jobs.push_front(job) }
            if jobs.len() > MAX_QUEUED { jobs.pop_front() } else { None }
        };
        self.ready.notify_one();
        if let Some(old) = dropped {
            old.dropped();
        }
    }
}

struct Shared {
    decoded: Mutex<Lru<Slot>>,
    encoded: Mutex<Lru<Arc<[u8]>>>,
    /// A cover finished since the app last looked ([`Images::take_arrived`]).
    arrived: AtomicBool,
}

pub struct Images {
    cache: Arc<ImageCache>,
    shared: Arc<Shared>,
    jobs: Arc<Stack>,
    client: Arc<Mutex<Option<Client>>>,
    waker: LateWaker,
    sync: AtomicBool,
    /// The window's device pixels per point, as the last view ran.
    scale: AtomicU32,
    disk: Option<PathBuf>,
}

impl Images {
    pub fn new(waker: LateWaker) -> Images {
        let disk = (rune::tooling::headless_run().is_none() && std::env::var_os("LUMEN_NO_DISK_CACHE").is_none())
            .then(|| crate::config::data_dir().join("Cache").join("covers"));
        if let Some(dir) = disk.clone() {
            std::thread::Builder::new().name("lumen-img-prune".into()).spawn(move || prune(&dir)).ok();
        }
        Images {
            cache: Arc::new(ImageCache::new(waker.as_waker())),
            shared: Arc::new(Shared {
                decoded: Mutex::new(Lru::new(DECODED_BUDGET)),
                encoded: Mutex::new(Lru::new(ENCODED_BUDGET)),
                arrived: AtomicBool::new(false),
            }),
            jobs: Stack::new(),
            client: Arc::default(),
            waker,
            sync: Default::default(),
            scale: AtomicU32::new(1.0f32.to_bits()),
            disk,
        }
    }

    /// Whether a cover finished (loaded or failed) since the last call: the
    /// view runs again to show it. The waker only runs `poll`, which commits
    /// nothing unless something says it changed, so a cover that arrived with
    /// nothing else going on stayed on its placeholder.
    pub fn take_arrived(&self) -> bool {
        self.shared.arrived.swap(false, Ordering::AcqRel)
    }


    /// The server covers are fetched from (its session included).
    pub fn set_client(&self, client: Option<Client>) {
        *self.client.lock().unwrap() = client;
        self.shared.decoded.lock().unwrap().clear();
        self.shared.encoded.lock().unwrap().clear();
    }

    /// Fetch and decode inline, for deterministic headless scenes.
    pub fn set_sync(&self, sync: bool) {
        self.sync.store(sync, Ordering::Relaxed);
    }

    /// The window's scale (device pixels per point); the root view sets it.
    pub fn set_scale(&self, scale: f32) {
        if scale.is_finite() && scale > 0.0 {
            self.scale.store(scale.to_bits(), Ordering::Relaxed);
        }
    }

    fn scale(&self) -> f32 {
        f32::from_bits(self.scale.load(Ordering::Relaxed))
    }

    /// The cover at `url` at its natural size (at most 512 px a side).
    pub fn get(&self, url: &str) -> Cover {
        self.request(url, None, true)
    }

    /// The cover at `url` drawn `w`×`h` points: decoded at those device
    /// pixels, cropped to fill them as `object-fit: cover` does.
    pub fn get_sized(&self, url: &str, w: f32, h: f32) -> Cover {
        self.request(url, Some(self.sized(w, h)), true)
    }

    /// [`Images::get_sized`] for a cover that may be off screen: its fetch
    /// waits behind every cover on screen until [`Images::want_sized`] says
    /// it shows (`CoverArt`'s `loading="lazy"`).
    pub fn get_sized_lazy(&self, url: &str, w: f32, h: f32) -> Cover {
        self.request(url, Some(self.sized(w, h)), false)
    }

    /// The cover came on screen: fetch it next (asking again if it was dropped).
    pub fn want_sized(&self, url: &str, w: f32, h: f32) {
        let size = self.sized(w, h);
        let key = Self::key(url, Some(size));
        let waiting = matches!(self.shared.decoded.lock().unwrap().get(&key), Some(Slot::Loading));
        if waiting {
            self.jobs.reorder(&key, true);
        } else {
            self.request(url, Some(size), true);
        }
    }

    /// The cover left the screen before it loaded: covers that show go first.
    pub fn unwant_sized(&self, url: &str, w: f32, h: f32) {
        self.jobs.reorder(&Self::key(url, Some(self.sized(w, h))), false);
    }

    fn sized(&self, w: f32, h: f32) -> (u32, u32, f32) {
        let s = self.scale();
        ((w * s).round().max(1.0) as u32, (h * s).round().max(1.0) as u32, w.max(h))
    }

    fn key(url: &str, size: Option<(u32, u32, f32)>) -> String {
        match size {
            Some((w, h, _)) => format!("{w}x{h}@{url}"),
            None => url.to_string(),
        }
    }

    fn request(&self, url: &str, size: Option<(u32, u32, f32)>, urgent: bool) -> Cover {
        let key = Self::key(url, size);
        if let Some(slot) = self.shared.decoded.lock().unwrap().get(&key) {
            return match slot {
                Slot::Loading => Cover::Loading,
                Slot::Ready(picture) => Cover::Ready(picture),
                Slot::Failed => Cover::Failed,
            };
        }
        let Some(client) = self.client.lock().unwrap().clone() else { return Cover::Failed };
        self.shared.decoded.lock().unwrap().put(key.clone(), Slot::Loading, 64);
        let job = Job {
            client,
            url: url.to_string(),
            key: key.clone(),
            size,
            scale: self.scale(),
            cache: self.cache.clone(),
            shared: self.shared.clone(),
            waker: self.waker.clone(),
            disk: self.disk.clone(),
        };
        if self.sync.load(Ordering::Relaxed) {
            job.run();
            return self.request(url, size, urgent);
        }
        self.jobs.push(job, urgent);
        Cover::Loading
    }
}

impl Drop for Images {
    fn drop(&mut self) {
        self.jobs.close();
    }
}

struct Job {
    client: Client,
    url: String,
    key: String,
    size: Option<(u32, u32, f32)>,
    scale: f32,
    cache: Arc<ImageCache>,
    shared: Arc<Shared>,
    waker: LateWaker,
    disk: Option<PathBuf>,
}

impl Task for Job {
    fn run(self) {
        Job::run(self);
    }

    fn key(&self) -> &str {
        &self.key
    }

    /// The slot is forgotten, so the row asks again if it shows again.
    fn dropped(self) {
        let mut decoded = self.shared.decoded.lock().unwrap();
        if matches!(decoded.get(&self.key), Some(Slot::Loading)) {
            decoded.remove(&self.key);
        }
    }
}

impl Job {
    fn run(self) {
        let (slot, bytes) = match self.encoded() {
            Some(bytes) => self.decode(&bytes),
            None => (Slot::Failed, 64),
        };
        self.shared.decoded.lock().unwrap().put(self.key.clone(), slot, bytes);
        self.shared.arrived.store(true, Ordering::Release);
        self.waker.wake();
    }

    /// The cover's encoded bytes: memory, then disk while fresh, then the
    /// server (a stale disk copy stands in if the server can't answer).
    fn encoded(&self) -> Option<Arc<[u8]>> {
        let mem_key = format!("{}|{}", self.client.base(), self.url);
        if let Some(b) = self.shared.encoded.lock().unwrap().get(&mem_key) {
            return Some(b);
        }
        let file = self.disk.as_ref().map(|d| d.join(disk_name(&mem_key)));
        let stale = file.as_ref().and_then(|f| read_disk(f));
        if let Some((bytes, expires)) = &stale
            && *expires > now_secs()
        {
            let b: Arc<[u8]> = Arc::from(bytes.clone());
            self.shared.encoded.lock().unwrap().put(mem_key, b.clone(), bytes.len());
            return Some(b);
        }
        match self.client.bytes_reply(&self.url) {
            Ok(reply) if !reply.body.is_empty() => {
                let b: Arc<[u8]> = Arc::from(reply.body.clone());
                self.shared.encoded.lock().unwrap().put(mem_key, b.clone(), reply.body.len());
                if let (Some(f), Some(age)) = (&file, max_age(reply.cache_control.as_deref())) {
                    write_disk(f, &reply.body, now_secs() + age);
                }
                Some(b)
            }
            _ => stale.map(|(bytes, _)| Arc::from(bytes)),
        }
    }

    fn decode(&self, bytes: &[u8]) -> (Slot, usize) {
        let svg = bytes.iter().take(512).copied().collect::<Vec<u8>>();
        let svg = String::from_utf8_lossy(&svg).contains("<svg");
        if svg {
            let pt = self.size.map_or(UNSIZED_MAX as f32 / self.scale, |(_, _, pt)| pt);
            let px = (pt * self.scale) as usize;
            // Rune rasterizes it, with mips: a third more than its pixels.
            return (Self::ready(self.cache.svg(bytes.to_vec(), pt, self.scale)), px * px * 16 / 3);
        }
        let Ok(img) = image::load_from_memory(bytes) else {
            // A format the decoder here lacks: hand it to Rune's.
            return (Self::ready(self.cache.load(bytes.to_vec())), 256 * 256 * 16 / 3);
        };
        let rgba = img.to_rgba8();
        let (iw, ih) = rgba.dimensions();
        let (out, w, h) = match self.size {
            Some((w, h, _)) => (cover_fill(&rgba, w, h), w, h),
            None if iw.max(ih) > UNSIZED_MAX => {
                let k = UNSIZED_MAX as f32 / iw.max(ih) as f32;
                let (w, h) = (((iw as f32 * k).round() as u32).max(1), ((ih as f32 * k).round() as u32).max(1));
                (image::imageops::resize(&rgba, w, h, image::imageops::FilterType::Lanczos3), w, h)
            }
            None => (rgba, iw, ih),
        };
        // Decoded at the device pixels it's drawn at, so it draws 1:1 and
        // needs no mips: the pixels as they are (`Pixels::set`), one buffer.
        // `ImageCache::rgba` premultiplied a copy and built a mip chain, a
        // third again as much, for every cover held.
        let n = (w * h * 4) as usize;
        let pixels = rune::Pixels::new();
        pixels.set(w, h, out.into_raw());
        (Slot::Ready(Picture(pixels)), n)
    }

    /// An `ImageCache` image once its worker has it: its pixels keep it alive.
    fn ready(image: Image) -> Slot {
        match image.wait() {
            Ok(_) => Slot::Ready(Picture(image.pixels().clone())),
            Err(_) => Slot::Failed,
        }
    }
}

/// `object-fit: cover`: scale `src` to cover `w`×`h`, crop the centred
/// overflow, with a Lanczos filter.
fn cover_fill(src: &image::RgbaImage, w: u32, h: u32) -> image::RgbaImage {
    let (iw, ih) = src.dimensions();
    let k = (w as f32 / iw as f32).max(h as f32 / ih as f32);
    let (cw, ch) = (((w as f32 / k).round() as u32).clamp(1, iw), ((h as f32 / k).round() as u32).clamp(1, ih));
    let (x, y) = ((iw - cw) / 2, (ih - ch) / 2);
    let view = image::imageops::crop_imm(src, x, y, cw, ch).to_image();
    if (cw, ch) == (w, h) {
        return view;
    }
    image::imageops::resize(&view, w, h, image::imageops::FilterType::Lanczos3)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// `max-age` from `Cache-Control`; None when the reply mustn't be stored.
fn max_age(cc: Option<&str>) -> Option<u64> {
    let cc = cc?.to_ascii_lowercase();
    if cc.contains("no-store") || cc.contains("no-cache") {
        return None;
    }
    cc.split(',').find_map(|d| d.trim().strip_prefix("max-age=")?.trim().parse::<u64>().ok()).filter(|&a| a > 0)
}

fn disk_name(key: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA256, key.as_bytes());
    d.as_ref()[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// A cached file: 8 bytes of expiry (unix seconds, little-endian), then the body.
fn read_disk(path: &PathBuf) -> Option<(Vec<u8>, u64)> {
    let data = std::fs::read(path).ok()?;
    if data.len() < 8 {
        return None;
    }
    let expires = u64::from_le_bytes(data[..8].try_into().ok()?);
    Some((data[8..].to_vec(), expires))
}

fn write_disk(path: &PathBuf, body: &[u8], expires: u64) {
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let mut data = Vec::with_capacity(body.len() + 8);
    data.extend_from_slice(&expires.to_le_bytes());
    data.extend_from_slice(body);
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, &data).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// Keep the disk cache under its budget: oldest files out first.
fn prune(dir: &PathBuf) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_file().then(|| (m.modified().unwrap_or(UNIX_EPOCH), m.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= DISK_BUDGET {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= DISK_BUDGET {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_age_reads_cache_control() {
        assert_eq!(max_age(Some("private, max-age=86400")), Some(86400));
        assert_eq!(max_age(Some("private, no-store")), None);
        assert_eq!(max_age(Some("public")), None);
        assert_eq!(max_age(None), None);
    }

    #[test]
    fn the_lru_keeps_its_byte_budget() {
        let mut l: Lru<u8> = Lru::new(100);
        l.put("a".into(), 1, 60);
        l.put("b".into(), 2, 30);
        assert_eq!(l.get("a"), Some(1)); // a is now the most recent
        l.put("c".into(), 3, 30);
        assert!(l.map.contains_key("a") && l.map.contains_key("c") && !l.map.contains_key("b"));
        assert!(l.bytes <= 100);
    }

    #[test]
    fn the_lru_forgets_and_replaces_entries() {
        let mut l: Lru<u8> = Lru::new(100);
        l.put("a".into(), 1, 40);
        l.put("a".into(), 2, 50);
        assert_eq!((l.get("a"), l.bytes, l.order.len()), (Some(2), 50, 1));
        assert_eq!(l.remove("a"), Some(2));
        assert_eq!((l.bytes, l.order.len(), l.map.len()), (0, 0, 0));
        assert_eq!(l.get("a"), None);
    }

    struct Probe(u32, Arc<Mutex<Vec<(u32, bool)>>>);

    impl Task for Probe {
        fn run(self) {
            self.1.lock().unwrap().push((self.0, true));
        }
        fn dropped(self) {
            self.1.lock().unwrap().push((self.0, false));
        }
        fn key(&self) -> &str {
            ["a", "b", "c", "d"].get(self.0 as usize).copied().unwrap_or("")
        }
    }

    #[test]
    fn the_stack_runs_the_newest_first_and_drops_the_oldest() {
        let stack: Arc<Stack<Probe>> = Stack::new();
        let log = Arc::new(Mutex::new(Vec::new()));
        // Held so nothing starts: the queue fills as a fast scroll would fill it.
        stack.started.call_once(|| {});
        for n in 0..MAX_QUEUED as u32 + 3 {
            stack.push(Probe(n, log.clone()), true);
        }
        assert_eq!(*log.lock().unwrap(), vec![(0, false), (1, false), (2, false)]);
        log.lock().unwrap().clear();
        let s = stack.clone();
        let worker = std::thread::spawn(move || s.work());
        while stack.jobs.lock().unwrap().len() > 0 {
            std::thread::yield_now();
        }
        stack.close();
        worker.join().unwrap();
        let ran: Vec<u32> = log.lock().unwrap().iter().map(|&(n, _)| n).collect();
        assert_eq!(ran.first(), Some(&(MAX_QUEUED as u32 + 2)));
        assert!(ran.windows(2).all(|w| w[0] > w[1]));
    }

    #[test]
    fn lazy_jobs_wait_in_order_until_they_show() {
        let stack: Arc<Stack<Probe>> = Stack::new();
        let log = Arc::new(Mutex::new(Vec::new()));
        stack.started.call_once(|| {});
        // A grid asks for four covers top to bottom; the third comes on screen.
        for n in 0..4 {
            stack.push(Probe(n, log.clone()), false);
        }
        assert!(stack.reorder("c", true));
        assert!(!stack.reorder("x", true));
        let order: Vec<u32> = stack.jobs.lock().unwrap().iter().rev().map(|p| p.0).collect();
        assert_eq!(order, vec![2, 0, 1, 3]);
        // It scrolls away again before it loads.
        assert!(stack.reorder("c", false));
        let order: Vec<u32> = stack.jobs.lock().unwrap().iter().rev().map(|p| p.0).collect();
        assert_eq!(order, vec![0, 1, 3, 2]);
    }

    #[test]
    fn cover_fill_crops_to_the_box() {
        let src = image::RgbaImage::from_pixel(200, 100, image::Rgba([1, 2, 3, 255]));
        let out = cover_fill(&src, 48, 48);
        assert_eq!(out.dimensions(), (48, 48));
    }
}
