//! `Recent.tsx`, at `/recent`: the last 100 tracks played, each once.

use rune::{Cx, El, col};

use crate::api::TrackListItem;
use crate::app::App;
use crate::resource::{self, Res};
use crate::route::Location;
use crate::theme::Theme;
use crate::ui::blocks::{ListHeader, list_page_header, meta_line};
use crate::ui::kit::{empty_state, error_banner};
use crate::ui::track_list::TrackList;
use crate::ui::icons as i;

/// `useApiResource("recent:100")`: kept between visits, refreshed on each.
#[derive(Default)]
pub struct State {
    pub tracks: Res<Vec<TrackListItem>>,
}

/// Runs on each navigation to the page: show what it had, refresh behind it.
pub fn enter(app: &mut App, loc: &Location) {
    let _ = loc;
    resource::load(
        app,
        |app| Some(&mut app.pages.recent.tracks),
        |c| crate::api::library::list_recent(c, 100),
        "Failed to load recent plays.",
        |_| {},
    );
}

fn tracks(app: &App) -> &[TrackListItem] {
    app.pages.recent.tracks.data.as_deref().unwrap_or_default()
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let _ = cx;
    let s = &app.pages.recent;
    let list = s.tracks.data.as_deref();
    let count = list.map_or_else(|| "—".to_string(), |l| crate::format::pluralize(l.len() as u64, "track"));
    let playable = list.is_some_and(|l| l.iter().any(|t| t.unavailable != Some(true)));
    let header = list_page_header(
        app,
        t,
        "recent-header",
        ListHeader {
            kind: "Recent",
            title: "Recently played",
            hero: list.and_then(|l| l.first()),
            fallback_icon: Some(&i::CLOCK),
            meta: Some(meta_line(t, &[&count, "each track once, most recent first"])),
            actions: Some(crate::ui::blocks::list_play_actions(t, "recent", tracks, !playable)),
            ..Default::default()
        },
    );
    let mut head = col().w_full().gap(18.0).child(header);
    if let Some(e) = &s.tracks.error {
        head = head.child(error_banner(t, e));
    }
    if list.is_none() {
        return col().w_full().padding(t.pad()).child(head);
    }
    TrackList::new("recent", tracks)
        .view_gap(18.0)
        .empty(empty_state(t, None, "Nothing played yet.", Some("Play some tracks from the library and they'll show up here."), None))
        .page(app, t, head, None)
}
