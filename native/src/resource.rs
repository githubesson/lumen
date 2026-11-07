//! `lib/useApiResource.ts`: data a page loads and keeps between visits (the
//! hook's cache), the last load's error, and whether a load is out. A reload
//! supersedes the load before it: only the latest one's reply lands, and a
//! reply whose resource is gone (a closed dialog's) is dropped. A change
//! applied with [`Res::update`] is newer than any load out at the time: that
//! load's reply settles without landing.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::api::{ApiResult, Client, error_message};
use crate::app::App;

/// Every load of every resource takes its own ticket, so a late reply never
/// passes for another load's, not even one of a resource made afresh since
/// (a dialog opened again).
static TICKETS: AtomicU64 = AtomicU64::new(1);

/// A ticket no other load (or timer) has.
pub fn ticket() -> u64 {
    TICKETS.fetch_add(1, Ordering::Relaxed)
}

/// `useApiResource`'s state.
#[derive(Clone, Debug)]
pub struct Res<T> {
    pub data: Option<T>,
    pub error: Option<String>,
    pub loading: bool,
    /// The latest load's ticket (0 before the first).
    ticket: u64,
    /// Bumped by each [`Res::update`], and its count when the latest load
    /// began.
    updates: u64,
    updates_at: u64,
}

impl<T> Default for Res<T> {
    fn default() -> Self {
        Res { data: None, error: None, loading: false, ticket: 0, updates: 0, updates_at: 0 }
    }
}

impl<T> Res<T> {
    /// A load starts, superseding any still out: the ticket its reply carries.
    pub fn begin(&mut self) -> u64 {
        self.ticket = ticket();
        self.loading = true;
        self.error = None;
        self.updates_at = self.updates;
        self.ticket
    }

    /// The reply to load `ticket`, settled only when that's still the latest
    /// load (true when it was); its data or error lands unless an
    /// [`update`](Res::update) came after the load began.
    pub fn settle(&mut self, ticket: u64, result: ApiResult<T>, fallback: &str) -> bool {
        if self.ticket != ticket {
            return false;
        }
        self.loading = false;
        if self.updates == self.updates_at {
            match result {
                Ok(data) => self.data = Some(data),
                Err(e) => self.error = Some(error_message(&e, fallback)),
            }
        }
        true
    }

    /// `update`: a change already made, applied ahead of any refetch; a load
    /// out now no longer lands.
    pub fn update(&mut self, f: impl FnOnce(&mut T)) {
        self.updates += 1;
        if let Some(data) = self.data.as_mut() {
            f(data);
        }
    }

    /// Data known without a request (superseding any load out).
    pub fn set(&mut self, data: T) {
        let ticket = self.begin();
        self.settle(ticket, Ok(data), "");
    }

    /// A load has begun, at least once.
    pub fn started(&self) -> bool {
        self.ticket != 0
    }
}

/// Load `fetch` into the resource `lens` reaches, then run `then`. The reply
/// lands only if no later load superseded it and `lens` still finds the
/// resource; `then` runs either way (the web settles a reload's waiters when
/// its owner unmounts, too).
pub fn load<T, L>(
    app: &mut App,
    lens: L,
    fetch: impl FnOnce(&Client) -> ApiResult<T> + Send + 'static,
    fallback: &'static str,
    then: impl FnOnce(&mut App) + Send + 'static,
) where
    T: Send + 'static,
    L: Fn(&mut App) -> Option<&mut Res<T>> + Send + 'static,
{
    let Some(client) = app.client.clone() else { return };
    let Some(res) = lens(app) else { return };
    let ticket = res.begin();
    app.net.run(
        move || fetch(&client),
        move |app, result| {
            if let Some(res) = lens(app) {
                res.settle(ticket, result, fallback);
            }
            then(app);
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::ApiError;

    #[test]
    fn only_the_latest_load_lands() {
        let mut res = Res::<u32>::default();
        let first = res.begin();
        let second = res.begin();
        assert!(!res.settle(first, Ok(1), "x"));
        assert_eq!((res.data, res.loading), (None, true));
        assert!(res.settle(second, Err(ApiError::http(500, "boom")), "x"));
        assert_eq!((res.error.as_deref(), res.loading), (Some("boom"), false));
    }

    #[test]
    fn an_update_outdates_the_load_out() {
        let mut res = Res::<u32>::default();
        res.set(1);
        let out = res.begin();
        res.update(|n| *n += 1);
        assert!(res.settle(out, Ok(9), "x"));
        assert_eq!((res.data, res.loading), (Some(2), false));
        let next = res.begin();
        assert!(res.settle(next, Ok(9), "x"));
        assert_eq!(res.data, Some(9));
    }

    #[test]
    fn a_fresh_resource_takes_no_older_reply() {
        let mut old = Res::<u32>::default();
        let late = old.begin();
        let mut fresh = Res::<u32>::default();
        fresh.begin();
        assert!(!fresh.settle(late, Ok(1), "x"));
        assert_eq!(fresh.data, None);
    }
}
