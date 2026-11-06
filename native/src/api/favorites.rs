//! Favorites (`favorite`, `unfavorite`, `listFavorites`). The optimistic
//! toggle state lives in `core::favorites`.

use super::client::{ApiResult, Client, seg};
use super::types::TrackListItem;

/// The server's largest page; fewer round trips for long lists.
const FAVORITES_PAGE: usize = 500;

pub fn favorite(c: &Client, id: &str) -> ApiResult<()> {
    c.post_void(&format!("/api/tracks/{}/favorite", seg(id)), None)
}

pub fn unfavorite(c: &Client, id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/tracks/{}/favorite", seg(id)))
}

/// Every favorite, most recent first, page after page until one comes
/// back short.
pub fn list_favorites(c: &Client) -> ApiResult<Vec<TrackListItem>> {
    let mut tracks = Vec::new();
    let mut offset = 0;
    loop {
        let page: Vec<TrackListItem> = c.get_list(&format!("/api/favorites?limit={FAVORITES_PAGE}&offset={offset}"))?;
        let n = page.len();
        tracks.extend(page);
        if n < FAVORITES_PAGE {
            return Ok(tracks);
        }
        offset += FAVORITES_PAGE;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::testing::{MockServer, Res};

    fn rows(from: usize, n: usize) -> String {
        let items: Vec<String> = (from..from + n).map(|i| format!(r#"{{"id":"{i}","title":"t"}}"#)).collect();
        format!("[{}]", items.join(","))
    }

    // api.test.ts: complete favorites
    #[test]
    fn includes_favorites_beyond_the_default_page() {
        let server = MockServer::start(vec![Res::json(&rows(0, 500)), Res::json(&rows(500, 17))]);
        assert_eq!(list_favorites(&server.client()).unwrap().len(), 517);
        let paths: Vec<String> = server.requests().into_iter().map(|r| r.path).collect();
        assert_eq!(paths, ["/api/favorites?limit=500&offset=0", "/api/favorites?limit=500&offset=500"]);
    }
}
