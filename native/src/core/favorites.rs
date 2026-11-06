//! Favorites: `core/src/favorites/favorite-toggle.ts` (the optimistic
//! transitions and the in-flight guard) and `favorites-core.tsx` as
//! [`Favorites`], the app's mirror of the server's favorite set.
//!
//! Toggling (the page runs the request on `app.net`):
//!
//! ```ignore
//! if let Some(t) = app.favorites.toggle(&id) {
//!     app.net.run(move || t.send(&client), move |app, r| {
//!         if app.favorites.toggled(&t, r) { /* refetch rows: list_favorites → rows_loaded */ }
//!     });
//! }
//! ```

use std::collections::HashSet;

use crate::api::{ApiError, ApiResult, Client, TrackListItem, favorites};

/// `withFavoriteId`: set membership to `favorited` (idempotent).
pub fn with_favorite_id(ids: &HashSet<String>, id: &str, favorited: bool) -> HashSet<String> {
    let mut next = ids.clone();
    if favorited {
        next.insert(id.to_string());
    } else {
        next.remove(id);
    }
    next
}

/// `withFavorite`: the row list with `track` in or out. New favorites go to
/// `at` (the front by default, where the server's newest-first refetch puts
/// them); `None` when nothing changes.
pub fn with_favorite<T: Clone>(rows: &[T], track: &T, favorited: bool, at: usize, id: impl Fn(&T) -> &str) -> Option<Vec<T>> {
    let present = rows.iter().any(|r| id(r) == id(track));
    if favorited {
        if present {
            return None;
        }
        let mut out = rows.to_vec();
        out.insert(at.min(rows.len()), track.clone());
        Some(out)
    } else if present {
        Some(rows.iter().filter(|r| id(r) != id(track)).cloned().collect())
    } else {
        None
    }
}

/// `createToggleGuard`: drops a second toggle of a key while its first is
/// in flight, so two requests can't land out of order.
#[derive(Clone, Debug, Default)]
pub struct ToggleGuard {
    pending: HashSet<String>,
}

impl ToggleGuard {
    /// Whether the task may run; marks `key` in flight when so.
    pub fn begin(&mut self, key: &str) -> bool {
        self.pending.insert(key.to_string())
    }
    /// The task for `key` settled (succeeded or failed).
    pub fn end(&mut self, key: &str) {
        self.pending.remove(key);
    }
    pub fn is_pending(&self, key: &str) -> bool {
        self.pending.contains(key)
    }
}

/// A toggle the page sends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Toggle {
    pub id: String,
    /// What the request makes it: true favorites, false unfavorites.
    pub favorite: bool,
}

impl Toggle {
    pub fn send(&self, c: &Client) -> ApiResult<()> {
        if self.favorite { favorites::favorite(c, &self.id) } else { favorites::unfavorite(c, &self.id) }
    }
}

/// `FavoritesProvider`'s state: the ids, the rows (most recent first), and
/// whether a list has arrived.
#[derive(Clone, Debug, Default)]
pub struct Favorites {
    ids: HashSet<String>,
    rows: Vec<TrackListItem>,
    /// A list has arrived at least once (an empty one means no favorites).
    pub loaded: bool,
    pub loading: bool,
    pub error: Option<String>,
    guard: ToggleGuard,
}

impl Favorites {
    pub fn is_favorite(&self, id: &str) -> bool {
        self.ids.contains(id)
    }

    pub fn ids(&self) -> &HashSet<String> {
        &self.ids
    }

    /// Favorited rows, most recent first, always agreeing with the ids.
    pub fn tracks(&self) -> Vec<&TrackListItem> {
        self.rows.iter().filter(|r| self.ids.contains(&r.id)).collect()
    }

    /// A full refresh starts: run `api::favorites::list_favorites`.
    pub fn refresh(&mut self) {
        self.loading = true;
        self.error = None;
    }

    /// A full refresh answered.
    pub fn refreshed(&mut self, result: ApiResult<Vec<TrackListItem>>) {
        self.loading = false;
        match result {
            Ok(rows) => {
                self.ids = rows.iter().map(|r| r.id.clone()).collect();
                self.rows = rows;
                self.loaded = true;
            }
            Err(_) => self.error = Some("Could not load favorites.".into()),
        }
    }

    /// Toggle `id` optimistically; `None` while a toggle of it is in flight.
    pub fn toggle(&mut self, id: &str) -> Option<Toggle> {
        if !self.guard.begin(id) {
            return None;
        }
        let had = self.ids.contains(id);
        self.ids = with_favorite_id(&self.ids, id, !had);
        Some(Toggle { id: id.to_string(), favorite: !had })
    }

    /// The toggle answered: a failure rolls back from whatever the set is
    /// now. True when a new favorite's row should be fetched (run
    /// `list_favorites`, then [`Favorites::rows_loaded`]).
    pub fn toggled(&mut self, t: &Toggle, result: Result<(), ApiError>) -> bool {
        self.guard.end(&t.id);
        if result.is_err() {
            self.ids = with_favorite_id(&self.ids, &t.id, !t.favorite);
            return false;
        }
        t.favorite
    }

    /// Rows only (after a favorite): `ids` may be ahead of this response.
    pub fn rows_loaded(&mut self, result: ApiResult<Vec<TrackListItem>>) {
        if let Ok(rows) = result {
            self.rows = rows;
        }
    }

    /// Signed out: forget everything.
    pub fn clear(&mut self) {
        *self = Favorites::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str) -> TrackListItem {
        TrackListItem { id: id.into(), title: id.into(), ..Default::default() }
    }

    fn ids(v: &[&str]) -> HashSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // shared-helpers.test.ts: favorite toggle transitions
    #[test]
    fn transitions_are_idempotent() {
        let set = ids(&["a"]);
        assert_eq!(with_favorite_id(&set, "a", true), ids(&["a"]));
        assert_eq!(with_favorite_id(&set, "b", false), ids(&["a"]));
        assert_eq!(with_favorite_id(&set, "b", true), ids(&["a", "b"]));
        assert_eq!(with_favorite_id(&set, "a", false), ids(&[]));
        assert_eq!(set, ids(&["a"]));
        fn id(r: &TrackListItem) -> &str {
            &r.id
        }
        let rows = vec![row("a")];
        let got: Vec<String> = with_favorite(&rows, &row("b"), true, 0, id).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(got, ["b", "a"]);
        assert_eq!(with_favorite(&rows, &row("a"), true, 0, id), None);
        assert_eq!(with_favorite(&rows, &row("z"), false, 0, id), None);
        assert_eq!(with_favorite(&rows, &row("a"), false, 0, id), Some(vec![]));
        let rows = vec![row("a"), row("c")];
        let at = |r: TrackListItem, i| with_favorite(&rows, &r, true, i, id).unwrap().into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(at(row("b"), 1), ["a", "b", "c"]);
        assert_eq!(at(row("z"), 9), ["a", "c", "z"]);
        assert_eq!(with_favorite(&rows, &row("c"), true, 0, id), None);
    }

    // favorites.test.tsx
    #[test]
    fn guard_drops_a_second_run_until_the_first_settles() {
        let mut g = ToggleGuard::default();
        assert!(g.begin("t1"));
        assert!(!g.begin("t1"));
        assert!(g.begin("t2"));
        g.end("t1");
        assert!(g.begin("t1"));
    }

    #[test]
    fn ignores_a_second_toggle_in_flight() {
        let mut f = Favorites::default();
        let t = f.toggle("t1").unwrap();
        assert!(f.is_favorite("t1"));
        assert_eq!(f.toggle("t1"), None);
        assert!(f.is_favorite("t1"));
        assert!(f.toggled(&t, Ok(())));
    }

    #[test]
    fn drops_an_unfavorited_row_at_once_and_restores_it_on_failure() {
        let mut f = Favorites::default();
        f.refresh();
        f.refreshed(Ok(vec![row("a"), row("b")]));
        let t = f.toggle("a").unwrap();
        assert_eq!(f.tracks().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["b"]);
        assert!(!f.toggled(&t, Err(ApiError::transport("offline"))));
        assert!(f.is_favorite("a"));
        assert_eq!(f.tracks().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    }

    #[test]
    fn adds_a_new_favorites_row_once_the_server_has_it() {
        let mut f = Favorites::default();
        f.refreshed(Ok(vec![row("a")]));
        let t = f.toggle("new").unwrap();
        assert!(f.toggled(&t, Ok(())));
        f.rows_loaded(Ok(vec![row("new"), row("a")]));
        assert_eq!(f.tracks().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["new", "a"]);
        assert!(!f.loading);
        let t = f.toggle("other").unwrap();
        assert!(!f.toggled(&t, Err(ApiError::http(500, "x"))));
        assert!(!f.is_favorite("other"));
    }

    #[test]
    fn loaded_stays_through_refreshes() {
        let mut f = Favorites::default();
        assert!(!f.loaded);
        f.refresh();
        f.refreshed(Ok(vec![]));
        assert!(f.loaded && !f.loading);
        f.refresh();
        assert!(f.loading && f.loaded);
        let mut g = Favorites::default();
        g.refresh();
        g.refreshed(Err(ApiError::http(500, "x")));
        assert!(g.error.is_some() && !g.loaded);
    }

    #[test]
    fn keeps_a_track_unfavorited_during_the_row_refetch_hidden() {
        let mut f = Favorites::default();
        f.refreshed(Ok(vec![]));
        let t = f.toggle("new").unwrap();
        f.toggled(&t, Ok(()));
        let t2 = f.toggle("old").unwrap();
        f.toggled(&t2, Ok(()));
        let t3 = f.toggle("old").unwrap();
        f.toggled(&t3, Ok(()));
        f.rows_loaded(Ok(vec![row("new"), row("old")]));
        assert_eq!(f.tracks().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["new"]);
    }
}
