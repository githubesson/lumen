//! `core/src/events.ts`: app-wide notices. `library_changed` fires when the
//! library's contents may have changed (uploads, an admin rescan, a removed
//! root); the Library, Favorites and Recent pages refresh on it.
//!
//! An [`Event`] is a generation counter, so a page can compare the one it
//! last loaded at (`changed_since`) when it draws or polls, with listeners
//! for code that wants a callback.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

type Listener = Box<dyn Fn() + Send + Sync>;

pub struct Event {
    generation: AtomicU64,
    listeners: Mutex<Vec<(u64, Listener)>>,
    next_id: AtomicU64,
}

/// A listener's handle, for [`Event::off`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListenerId(u64);

impl Event {
    pub const fn new() -> Event {
        Event { generation: AtomicU64::new(0), listeners: Mutex::new(Vec::new()), next_id: AtomicU64::new(0) }
    }

    /// `emit`: bump the generation and call every listener.
    pub fn emit(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        for (_, f) in self.listeners.lock().unwrap().iter() {
            f();
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Whether it fired since `seen` (a [`Event::generation`] read earlier).
    pub fn changed_since(&self, seen: u64) -> bool {
        self.generation() != seen
    }

    /// `on`: call `f` on every emit until [`Event::off`].
    pub fn on(&self, f: impl Fn() + Send + Sync + 'static) -> ListenerId {
        let id = self.next_id.fetch_add(1, Ordering::AcqRel);
        self.listeners.lock().unwrap().push((id, Box::new(f)));
        ListenerId(id)
    }

    pub fn off(&self, id: ListenerId) {
        self.listeners.lock().unwrap().retain(|(i, _)| *i != id.0);
    }
}

impl Default for Event {
    fn default() -> Self {
        Event::new()
    }
}

/// `libraryChanged`.
pub static LIBRARY_CHANGED: Event = Event::new();

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn emits_to_listeners_and_bumps_the_generation() {
        let e = Event::new();
        let seen = e.generation();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let id = e.on(move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        e.emit();
        assert!(e.changed_since(seen));
        e.off(id);
        e.emit();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
