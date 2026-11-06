//! `lib/usePaginatedList.ts`: a list loaded a page at a time, with resets
//! that drop late replies, "load more" as its end nears, and a reload that
//! keeps what's shown. Pages keep a [`Paginated`] in their state and reach it
//! through an accessor, so handlers and replies find it again:
//!
//! ```ignore
//! fn tracks(app: &mut App) -> &mut Paginated<TrackListItem> { &mut app.pages.library.tracks }
//! Paginated::reset(app, tracks, fetch_tracks, &query, true);
//! // In the view: load_more when the list's end comes near.
//! blocks::load_more(t, "tracks-more", list.has_more, list.loading_more, |app| Paginated::load_more(app, tracks, fetch_tracks));
//! ```

use crate::api::{ApiError, ApiResult, Client};
use crate::app::App;

/// `SearchOffsets`: search's per-source cursors.
pub type SearchOffsets = serde_json::Map<String, serde_json::Value>;

/// `PageRequest`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PageRequest {
    pub limit: u64,
    pub offset: u64,
    pub q: Option<String>,
    pub search_offsets: Option<SearchOffsets>,
}

/// `Page<T>`: one page and where the next starts.
#[derive(Clone, Debug, PartialEq)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: u64,
    /// Search's cursors: an empty map means it's done.
    pub next_offsets: Option<SearchOffsets>,
}

/// `nextPageParam`: whether there's a page after `last` once `loaded` rows
/// are in.
pub fn has_next<T>(last: &Page<T>, loaded: u64) -> bool {
    match &last.next_offsets {
        Some(o) => !o.is_empty(),
        None => loaded < last.total,
    }
}

/// Fetches one page (runs on a network worker).
pub type Fetcher<T> = fn(&Client, &PageRequest) -> ApiResult<Page<T>>;
/// Where a page keeps its list in the app's state.
pub type Access<T> = fn(&mut App) -> &mut Paginated<T>;

/// The hook's state.
#[derive(Clone, Debug)]
pub struct Paginated<T> {
    /// None until the first page lands.
    pub items: Option<Vec<T>>,
    pub total: Option<u64>,
    pub has_more: bool,
    pub loading_more: bool,
    pub error: Option<String>,
    pub page_size: u64,
    query: String,
    loaded_query: Option<String>,
    next_offsets: Option<SearchOffsets>,
    /// Bumped by each reset: replies to older requests are dropped.
    token: u64,
    loading: bool,
}

impl<T> Default for Paginated<T> {
    fn default() -> Self {
        Paginated {
            items: None,
            total: None,
            has_more: false,
            loading_more: false,
            error: None,
            page_size: 100,
            query: String::new(),
            loaded_query: None,
            next_offsets: None,
            token: 0,
            loading: false,
        }
    }
}

fn error_message(e: &ApiError) -> String {
    if e.status != 0 && !e.message.is_empty() { e.message.clone() } else { "Failed to load.".into() }
}

impl<T: Clone + Send + 'static> Paginated<T> {
    /// The items show a previous query's results while the new one loads.
    pub fn stale(&self) -> bool {
        self.items.is_some() && self.loaded_query.as_deref() != Some(self.query.as_str())
    }

    /// A new query (or a first visit): the first page again. With
    /// `keep_previous` the current items stay up until it lands.
    pub fn reset(app: &mut App, access: Access<T>, fetch: Fetcher<T>, query: &str, keep_previous: bool) {
        let s = access(app);
        s.query = query.to_string();
        s.error = None;
        if !keep_previous {
            s.items = None;
            s.total = None;
        }
        Self::load(app, access, fetch, 0, true, false);
    }

    /// `reload`: the first page (and as many more as are shown) again,
    /// keeping the current rows up meanwhile (`libraryChanged`).
    pub fn reload(app: &mut App, access: Access<T>, fetch: Fetcher<T>) {
        Self::load(app, access, fetch, 0, true, true);
    }

    /// The next page, when there is one and nothing is loading.
    pub fn load_more(app: &mut App, access: Access<T>, fetch: Fetcher<T>) {
        let s = access(app);
        if s.loading || !s.has_more {
            return;
        }
        let Some(n) = s.items.as_ref().map(Vec::len) else { return };
        Self::load(app, access, fetch, n as u64, false, false);
    }

    fn load(app: &mut App, access: Access<T>, fetch: Fetcher<T>, offset: u64, reset: bool, preserve: bool) {
        let Some(client) = app.client.clone() else { return };
        let s = access(app);
        if reset {
            s.token += 1;
            s.loading_more = false;
            if !preserve {
                s.has_more = false;
                s.next_offsets = None;
            }
        } else {
            s.loading_more = true;
        }
        s.loading = true;
        let token = s.token;
        let query = s.query.clone();
        let target = if preserve { s.items.as_ref().map_or(0, Vec::len) as u64 } else { 0 };
        let page_size = s.page_size;
        let limit = if preserve { page_size.max(target.min(1000)) } else { page_size };
        let first = PageRequest {
            limit,
            offset,
            q: Some(query.trim().to_string()).filter(|q| !q.is_empty()),
            search_offsets: if reset { None } else { s.next_offsets.clone() },
        };
        app.net.run(
            move || -> ApiResult<(Vec<T>, Page<T>)> {
                let mut page = fetch(&client, &first)?;
                let mut collected = page.items.clone();
                // A reload refetches as many rows as were shown.
                while (collected.len() as u64) < target && has_next(&page, collected.len() as u64) && !page.items.is_empty() {
                    let req = PageRequest {
                        limit,
                        offset: collected.len() as u64,
                        q: first.q.clone(),
                        search_offsets: page.next_offsets.clone(),
                    };
                    page = fetch(&client, &req)?;
                    collected.extend(page.items.iter().cloned());
                }
                Ok((collected, page))
            },
            move |app, result| {
                let s = access(app);
                if token != s.token {
                    return;
                }
                s.loading = false;
                if !reset {
                    s.loading_more = false;
                }
                match result {
                    Ok((collected, page)) => {
                        let loaded = offset + collected.len() as u64;
                        let more = has_next(&page, loaded);
                        s.has_more = more;
                        s.total = if page.next_offsets.is_some() && more { None } else { Some(page.total) };
                        s.next_offsets = page.next_offsets;
                        match (&mut s.items, reset) {
                            (Some(items), false) => items.extend(collected),
                            _ => s.items = Some(collected),
                        }
                        s.loaded_query = Some(query);
                        s.error = None;
                    }
                    Err(e) => {
                        s.error = Some(error_message(&e));
                        if reset && s.items.as_ref().is_none_or(Vec::is_empty) {
                            s.items = Some(Vec::new());
                            s.loaded_query = Some(query);
                        }
                    }
                }
            },
        );
    }
}

/// A plain `?limit=&offset=&q=` page from `path` (most lists), with the
/// total from `X-Total-Count`.
pub fn fetch_offset_page<T: serde::de::DeserializeOwned>(client: &Client, path: &str, req: &PageRequest) -> ApiResult<Page<T>> {
    let mut url = format!("{path}{}limit={}&offset={}", if path.contains('?') { '&' } else { '?' }, req.limit, req.offset);
    if let Some(q) = &req.q {
        url.push_str(&format!("&q={}", urlencoding::encode(q)));
    }
    let (items, total) = client.page::<T>(&url)?;
    Ok(Page { items, total, next_offsets: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_page() {
        let p: Page<u8> = Page { items: vec![1, 2], total: 5, next_offsets: None };
        assert!(has_next(&p, 2));
        assert!(!has_next(&p, 5));
        let s: Page<u8> = Page { items: vec![], total: 0, next_offsets: Some(SearchOffsets::new()) };
        assert!(!has_next(&s, 0));
    }
}
