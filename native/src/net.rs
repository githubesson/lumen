//! Background work: blocking requests run on a small worker pool, and their
//! results come back to the UI thread as closures over the app state, run in
//! `poll` ([`Net::drain`]). This is what `useEffect` + `fetch` + `setState` are
//! for the web app.
//!
//! Headless scenes switch the runner to [`Net::set_sync`]: work runs inline
//! on the calling thread, so a scene can load its data before the first
//! frame and snapshots are deterministic.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use rune::Waker;

use crate::app::App;

type Job = Box<dyn FnOnce() + Send>;
type Apply = Box<dyn FnOnce(&mut App) + Send>;

/// What every request says it is: `Lumen-Desktop/<release version>`.
pub const USER_AGENT: &str = concat!("Lumen-Desktop/", env!("LUMEN_VERSION"));

/// An HTTP agent's settings as every one of the app's starts: a non-2xx
/// status is an answer to read, not an error, and the app's user agent.
/// Callers add their timeouts and redirect rules.
pub fn agent_config() -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope> {
    ureq::Agent::config_builder().http_status_as_error(false).user_agent(USER_AGENT)
}

/// A waker that can be installed after the fact: the app is built before
/// rune hands over its waker in `setup`.
#[derive(Clone, Default)]
pub struct LateWaker(Arc<Mutex<Option<Waker>>>);

impl LateWaker {
    pub fn set(&self, waker: Waker) {
        *self.0.lock().unwrap() = Some(waker);
    }
    pub fn wake(&self) {
        if let Some(w) = self.0.lock().unwrap().as_ref() {
            w();
        }
    }
    pub fn as_waker(&self) -> Waker {
        let me = self.clone();
        Arc::new(move || me.wake())
    }
}

/// A fixed pool of worker threads.
#[derive(Clone)]
pub struct Pool {
    tx: Sender<Job>,
}

impl Pool {
    pub fn new(name: &str, workers: usize) -> Pool {
        let (tx, rx) = channel::<Job>();
        let rx = Arc::new(Mutex::new(rx));
        for i in 0..workers {
            let rx = rx.clone();
            std::thread::Builder::new()
                .name(format!("{name}-{i}"))
                .spawn(move || {
                    loop {
                        let job = { rx.lock().unwrap().recv() };
                        match job {
                            Ok(job) => job(),
                            Err(_) => break,
                        }
                    }
                })
                .expect("spawn worker");
        }
        Pool { tx }
    }

    pub fn spawn(&self, job: impl FnOnce() + Send + 'static) {
        let _ = self.tx.send(Box::new(job));
    }
}

pub struct Net {
    pool: Pool,
    tx: Sender<Apply>,
    rx: Receiver<Apply>,
    waker: LateWaker,
    sync: Arc<AtomicBool>,
    /// The timer thread [`Net::after`] hands its changes to, started on first use.
    timers: OnceLock<Sender<(Instant, Apply)>>,
}

impl Net {
    pub fn new(waker: LateWaker) -> Net {
        let (tx, rx) = channel();
        Net {
            pool: Pool::new("lumen-net", 6),
            tx,
            rx,
            waker,
            sync: Arc::new(AtomicBool::new(false)),
            timers: OnceLock::new(),
        }
    }

    /// Run `done` on the UI thread once `delay` has passed (a debounce, a
    /// "Copied" flag going back), without holding a request worker while it
    /// waits. Headless scenes run it on the next drain, as their requests.
    pub fn after(&self, delay: Duration, done: impl FnOnce(&mut App) + Send + 'static) {
        if self.is_sync() {
            let _ = self.tx.send(Box::new(done));
            return;
        }
        let timers = self.timers.get_or_init(|| start_timers(self.tx.clone(), self.waker.clone()));
        let _ = timers.send((Instant::now() + delay, Box::new(done)));
    }

    /// Run `work` off the UI thread and hand its result to `done` on it.
    pub fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
        done: impl FnOnce(&mut App, T) + Send + 'static,
    ) {
        let tx = self.tx.clone();
        let waker = self.waker.clone();
        let job = move || {
            let result = work();
            let _ = tx.send(Box::new(move |app: &mut App| done(app, result)));
            waker.wake();
        };
        if self.sync.load(Ordering::Relaxed) {
            job();
        } else {
            self.pool.spawn(job);
        }
    }

    /// Queue a change to the state for the next `poll`, from any thread.
    pub fn sender(&self) -> NetSender {
        NetSender { tx: self.tx.clone(), waker: self.waker.clone() }
    }

    /// Run inline (headless scenes).
    pub fn set_sync(&self, sync: bool) {
        self.sync.store(sync, Ordering::Relaxed);
    }

    pub fn is_sync(&self) -> bool {
        self.sync.load(Ordering::Relaxed)
    }

    /// Apply every finished result; true when any ran.
    pub fn drain(app: &mut App) -> bool {
        let mut any = false;
        // Results can start more work; in sync mode that lands at once, so
        // keep going until the queue is empty.
        loop {
            let next = app.net.rx.try_recv();
            match next {
                Ok(apply) => {
                    apply(app);
                    any = true;
                }
                Err(_) => break,
            }
        }
        any
    }
}

/// The thread behind [`Net::after`]: holds each change until its time, then
/// queues it for the UI thread (in the order they fall due).
fn start_timers(apply: Sender<Apply>, waker: LateWaker) -> Sender<(Instant, Apply)> {
    let (tx, rx) = channel::<(Instant, Apply)>();
    std::thread::Builder::new()
        .name("lumen-timers".into())
        .spawn(move || {
            let mut pending: Vec<(Instant, Apply)> = Vec::new();
            loop {
                let next = pending.iter().map(|(at, _)| *at).min();
                let got = match next {
                    Some(at) => rx.recv_timeout(at.saturating_duration_since(Instant::now())),
                    None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                };
                match got {
                    Ok(timer) => pending.push(timer),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                let now = Instant::now();
                let (due, later): (Vec<_>, Vec<_>) = pending.drain(..).partition(|(at, _)| *at <= now);
                pending = later;
                if !due.is_empty() {
                    for (_, done) in due {
                        let _ = apply.send(done);
                    }
                    waker.wake();
                }
            }
        })
        .expect("spawn timers");
    tx
}

/// A handle background threads (the audio engine, sockets) use to change
/// state on the UI thread.
#[derive(Clone)]
pub struct NetSender {
    tx: Sender<Apply>,
    waker: LateWaker,
}

impl NetSender {
    pub fn send(&self, f: impl FnOnce(&mut App) + Send + 'static) {
        let _ = self.tx.send(Box::new(f));
        self.waker.wake();
    }
}
