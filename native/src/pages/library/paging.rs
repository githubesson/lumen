//! `usePaginatedList` + `LoadMoreSentinel`: a list loaded a page at a time,
//! with race-safe resets (a page that lands after a newer reset is dropped),
//! the previous resource's rows kept up while the next one loads (`stale`),
//! and the next page fetched when the bottom of the list nears the window.

use std::sync::Arc;

use rune::{El, el};

pub use crate::api::Page as PageResult;
use crate::api::{ApiResult, Client, SearchOffsets, error_message};
use crate::app::App;
use crate::theme::Theme;

pub type Fetch<T> = Arc<dyn Fn(&Client, usize, usize, Option<&SearchOffsets>) -> ApiResult<PageResult<T>> + Send + Sync>;

/// Where a list's state lives in the app.
pub type Slot<T> = fn(&mut App) -> &mut Paged<T>;

/// Called with each page that commits (`reset` for a first page).
pub type OnPage<T> = fn(&mut App, &PageResult<T>, bool);

pub struct Paged<T> {
    pub items: Option<Vec<T>>,
    pub total: Option<u64>,
    pub has_more: bool,
    pub loading_more: bool,
    pub error: Option<String>,
    /// The resource (sort, search type + query) asked for, and the one the
    /// items on screen came from.
    pub key: String,
    pub loaded_key: Option<String>,
    pub page_size: usize,
    seq: u64,
    loading: bool,
    next_offsets: Option<SearchOffsets>,
    fetch: Option<Fetch<T>>,
    on_page: Option<OnPage<T>>,
    /// The bottom sentinel is within reach of the window.
    pub near_end: bool,
    /// When the shown rows were last read from the server.
    pub loaded_at: Option<std::time::Instant>,
}

impl<T> Paged<T> {
    pub fn new(page_size: usize) -> Paged<T> {
        Paged {
            items: None,
            total: None,
            has_more: false,
            loading_more: false,
            error: None,
            key: String::new(),
            loaded_key: None,
            page_size,
            seq: 0,
            loading: false,
            next_offsets: None,
            fetch: None,
            on_page: None,
            near_end: false,
            loaded_at: None,
        }
    }

    /// The rows on screen belong to another resource than the one asked for.
    pub fn stale(&self) -> bool {
        self.items.is_some() && self.loaded_key.as_deref() != Some(self.key.as_str())
    }

    pub fn len(&self) -> Option<usize> {
        self.items.as_ref().map(Vec::len)
    }
}

/// Start over for `key` with `fetch` (a new sort or query, or a revisit).
/// With `keep_previous` the current rows stay up (stale) until the first
/// page lands; otherwise a changed key drops back to loading.
pub fn reload<T: Clone + Send + 'static>(
    app: &mut App,
    slot: Slot<T>,
    key: String,
    fetch: Fetch<T>,
    keep_previous: bool,
    on_page: Option<OnPage<T>>,
) {
    let p = slot(app);
    p.error = None;
    if p.key != key && !keep_previous && p.loaded_key.as_deref() != Some(key.as_str()) {
        p.items = None;
        p.total = None;
    }
    p.key = key;
    p.fetch = Some(fetch);
    p.on_page = on_page;
    p.seq += 1;
    p.loading_more = false;
    p.has_more = false;
    p.next_offsets = None;
    run(app, slot, 0, true);
}

/// The next page, when there is one and nothing is loading.
pub fn load_more<T: Clone + Send + 'static>(app: &mut App, slot: Slot<T>) {
    let p = slot(app);
    if p.loading || !p.has_more || p.stale() {
        return;
    }
    p.loading_more = true;
    let offset = p.len().unwrap_or(0);
    run(app, slot, offset, false);
}

fn run<T: Clone + Send + 'static>(app: &mut App, slot: Slot<T>, offset: usize, reset: bool) {
    let Some(client) = app.client.clone() else { return };
    let p = slot(app);
    let Some(fetch) = p.fetch.clone() else { return };
    p.loading = true;
    let seq = p.seq;
    let key = p.key.clone();
    let limit = p.page_size;
    let offsets = if reset { None } else { p.next_offsets.clone() };
    app.net.run(
        move || fetch(&client, limit, offset, offsets.as_ref()),
        move |app, result| {
            let p = slot(app);
            if p.seq != seq {
                return;
            }
            p.loading = false;
            p.loading_more = false;
            match result {
                Ok(page) => {
                    let more = more_after(&page, page.items.len(), offset + page.items.len());
                    p.has_more = more;
                    p.total = if page.next_offsets.is_some() && more { None } else { Some(page.total) };
                    p.next_offsets = page.next_offsets.clone();
                    if reset || p.items.is_none() {
                        p.items = Some(page.items.clone());
                    } else if let Some(items) = &mut p.items {
                        items.extend(page.items.iter().cloned());
                    }
                    p.loaded_key = Some(key);
                    p.error = None;
                    if reset {
                        p.loaded_at = Some(std::time::Instant::now());
                    }
                    let on_page = p.on_page;
                    if let Some(f) = on_page {
                        f(app, &page, reset);
                    }
                }
                Err(e) => {
                    p.error = Some(error_message(&e, "Failed to load."));
                    if reset && p.items.as_ref().is_none_or(Vec::is_empty) {
                        p.items = Some(Vec::new());
                        p.loaded_key = Some(key);
                    }
                }
            }
        },
    );
}

/// Whether a list goes on past its first `loaded` rows, `page` being the
/// last one read (`last` rows long): a search's offsets say so; otherwise
/// the total does, but an empty offset page can't make progress, so it ends
/// the list even when a stale total claims more (or a visible sentinel would
/// ask for the same empty page forever).
fn more_after<T>(page: &PageResult<T>, last: usize, loaded: usize) -> bool {
    match &page.next_offsets {
        Some(o) => !o.is_empty(),
        None => last > 0 && (loaded as u64) < page.total,
    }
}

/// The quiet refresh (the poll's, and a library change seen again later):
/// the rows shown, read again from the top in batches of up to 1000 (page
/// after page, or a search's offsets, until as many as were shown) and put
/// in their place without a loading state, so the list keeps its scroll
/// and what was loaded past the first page. Failures keep what's there.
pub fn revalidate<T: Clone + Send + 'static>(app: &mut App, slot: Slot<T>) {
    let Some(client) = app.client.clone() else { return };
    let p = slot(app);
    let Some(fetch) = p.fetch.clone() else { return };
    if p.loading || p.stale() {
        return;
    }
    let shown = p.len().unwrap_or(0);
    let limit = p.page_size.max(shown.min(1000));
    p.loading = true;
    let seq = p.seq;
    app.net.run(
        move || -> ApiResult<(PageResult<T>, usize)> {
            let mut page = fetch(&client, limit, 0, None)?;
            let mut items = std::mem::take(&mut page.items);
            let mut last = items.len();
            while items.len() < shown && more_after(&page, last, items.len()) {
                page = fetch(&client, limit, items.len(), page.next_offsets.as_ref())?;
                last = page.items.len();
                items.append(&mut page.items);
            }
            page.items = items;
            Ok((page, last))
        },
        move |app, result| {
            let p = slot(app);
            if p.seq != seq {
                return;
            }
            p.loading = false;
            let Ok((page, last)) = result else { return };
            let more = more_after(&page, last, page.items.len());
            p.has_more = more;
            p.total = if page.next_offsets.is_some() && more { None } else { Some(page.total) };
            p.next_offsets = page.next_offsets.clone();
            p.items = Some(page.items.clone());
            p.loaded_at = Some(std::time::Instant::now());
            p.error = None;
            let on_page = p.on_page;
            if let Some(f) = on_page {
                f(app, &page, true);
            }
        },
    );
}

/// `LoadMoreSentinel`: an inert band over the list's last 1200 px that is
/// "on screen" (half showing) once the list's end is within 600 px of the
/// window's bottom, as the web's 600 px root margin. Mount it last, in a
/// container with the list. Plus the "Loading more…" line.
pub fn sentinel<T: Clone + Send + 'static>(t: &Theme, key: &str, p: &Paged<T>, slot: Slot<T>) -> Vec<El> {
    let mut out = Vec::new();
    if p.has_more {
        out.push(
            el().key(format!("{key}-sentinel"))
                .pin(Some(0.0), None, Some(0.0), Some(0.0))
                .h(1200.0)
                .inert()
                .on_visible(move |app: &mut App, on, _tx| {
                    slot(app).near_end = on;
                    if on {
                        load_more(app, slot);
                    }
                }),
        );
    }
    if p.loading_more {
        out.push(crate::ui::kit::loading_state(t, "Loading more…"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::TrackListItem;
    use std::sync::Mutex;

    /// A search's pages (80 rows at most, of 250), each read from the
    /// offsets the one before returned; the offsets it was asked from, logged.
    fn search_like(log: Arc<Mutex<Vec<Option<u64>>>>) -> Fetch<TrackListItem> {
        Arc::new(move |_, limit, _, offsets| {
            let from = offsets.map(|o| o["local"]);
            log.lock().unwrap().push(from);
            let from = from.unwrap_or(0) as usize;
            let to = (from + limit.min(80)).min(250);
            let next = if to < 250 { SearchOffsets::from([("local".to_string(), to as u64)]) } else { SearchOffsets::new() };
            let items = (from..to).map(|i| TrackListItem { id: format!("t{i}"), ..Default::default() }).collect();
            Ok(PageResult { items, total: 0, next_offsets: Some(next), warnings: Vec::new() })
        })
    }

    #[test]
    fn a_quiet_refresh_reads_every_search_page_shown_again() {
        let mut app = App::for_tests(Some(Client::new("http://127.0.0.1:9", None)));
        let slot: Slot<TrackListItem> = |a| &mut a.pages.library.tracks;
        let log = Arc::new(Mutex::new(Vec::new()));
        reload(&mut app, slot, "q".into(), search_like(log.clone()), true, None);
        while crate::net::Net::drain(&mut app) {}
        load_more(&mut app, slot);
        while crate::net::Net::drain(&mut app) {}
        assert_eq!(slot(&mut app).len(), Some(160));
        log.lock().unwrap().clear();
        revalidate(&mut app, slot);
        while crate::net::Net::drain(&mut app) {}
        assert_eq!(*log.lock().unwrap(), [None, Some(80)]);
        let p = slot(&mut app);
        let ids: Vec<&str> = p.items.iter().flatten().map(|t| t.id.as_str()).collect();
        assert_eq!((ids.len(), ids[159], p.has_more), (160, "t159", true));
        assert_eq!(p.next_offsets.as_ref().map(|o| o["local"]), Some(160));
    }
}
