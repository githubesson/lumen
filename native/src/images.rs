//! Cover art: fetched with the session on a worker, decoded by rune's
//! `ImageCache`, kept by URL. `CoverArt` in the web app shows the muted
//! surface (and the entity's initial once a fetch fails) until the image
//! decodes; [`Images::get`] gives the view what it needs to do the same.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rune::{Image, ImageCache};

use crate::api::Client;
use crate::net::{LateWaker, Pool};

#[derive(Clone)]
enum Slot {
    Loading,
    Ready(Image),
    Failed,
}

/// What a cover shows right now.
pub enum Cover {
    /// Fetching or decoding: the muted surface.
    Loading,
    Ready(Image),
    /// No image: the placeholder with the entity's initial.
    Failed,
}

pub struct Images {
    cache: Arc<ImageCache>,
    slots: Arc<Mutex<HashMap<String, Slot>>>,
    order: Arc<Mutex<Vec<String>>>,
    pool: Pool,
    client: Arc<Mutex<Option<Client>>>,
    waker: LateWaker,
    sync: std::sync::atomic::AtomicBool,
}

/// Decoded covers kept at once; the oldest are dropped past this.
const MAX_ENTRIES: usize = 600;

impl Images {
    pub fn new(waker: LateWaker) -> Images {
        Images {
            cache: Arc::new(ImageCache::new(waker.as_waker())),
            slots: Arc::default(),
            order: Arc::default(),
            pool: Pool::new("lumen-img", 4),
            client: Arc::default(),
            waker,
            sync: Default::default(),
        }
    }

    /// The server covers are fetched from (its session included).
    pub fn set_client(&self, client: Option<Client>) {
        *self.client.lock().unwrap() = client;
        self.slots.lock().unwrap().clear();
        self.order.lock().unwrap().clear();
    }

    /// Fetch and decode inline, for deterministic headless scenes.
    pub fn set_sync(&self, sync: bool) {
        self.sync.store(sync, std::sync::atomic::Ordering::Relaxed);
    }

    /// The cover at `url` (a server path or absolute URL), starting its
    /// fetch the first time it's asked for.
    pub fn get(&self, url: &str) -> Cover {
        if let Some(slot) = self.slots.lock().unwrap().get(url).cloned() {
            return match slot {
                Slot::Loading => Cover::Loading,
                Slot::Ready(img) if img.error().is_some() => Cover::Failed,
                Slot::Ready(img) if img.is_ready() => Cover::Ready(img),
                Slot::Ready(_) => Cover::Loading,
                Slot::Failed => Cover::Failed,
            };
        }
        let Some(client) = self.client.lock().unwrap().clone() else { return Cover::Failed };
        self.slots.lock().unwrap().insert(url.to_string(), Slot::Loading);
        {
            let mut order = self.order.lock().unwrap();
            order.push(url.to_string());
            if order.len() > MAX_ENTRIES {
                let excess = order.len() - MAX_ENTRIES;
                let drop: Vec<String> = order.drain(..excess).collect();
                let mut slots = self.slots.lock().unwrap();
                for k in drop {
                    slots.remove(&k);
                }
            }
        }
        let slots = self.slots.clone();
        let cache = self.cache.clone();
        let waker = self.waker.clone();
        let key = url.to_string();
        let fetch = move || {
            let slot = match client.bytes(&key) {
                Ok((bytes, _)) if !bytes.is_empty() => Slot::Ready(cache.load(bytes)),
                _ => Slot::Failed,
            };
            if let Slot::Ready(img) = &slot
                && img.wait().is_err()
            {
                slots.lock().unwrap().insert(key, Slot::Failed);
                waker.wake();
                return;
            }
            slots.lock().unwrap().insert(key, slot);
            waker.wake();
        };
        if self.sync.load(std::sync::atomic::Ordering::Relaxed) {
            fetch();
            return self.get(url);
        }
        self.pool.spawn(fetch);
        Cover::Loading
    }
}
