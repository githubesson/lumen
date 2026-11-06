//! `Recent.tsx`, at `/recent`: the last 100 tracks played, each once.

use rune::{Cx, El, col};

use crate::api::TrackListItem;
use crate::app::App;
use crate::route::Location;
use crate::theme::Theme;
use crate::ui::blocks::{ListHeader, list_page_header, meta_line, play_list_button};
use crate::ui::kit::{empty_state, error_banner};
use crate::ui::track_list::TrackList;
use crate::ui::icons as i;

/// `useApiResource("recent:100")`: kept between visits, refreshed on each.
#[derive(Default)]
pub struct State {
    pub tracks: Option<Vec<TrackListItem>>,
    pub error: Option<String>,
    serial: u64,
}

/// Runs on each navigation to the page: show what it had, refresh behind it.
pub fn enter(app: &mut App, loc: &Location) {
    let _ = loc;
    let Some(client) = app.client.clone() else { return };
    let s = &mut app.pages.recent;
    s.serial += 1;
    let serial = s.serial;
    app.net.run(
        move || client.get::<Option<Vec<TrackListItem>>>("/api/recent?limit=100"),
        move |app, result| {
            let s = &mut app.pages.recent;
            if s.serial != serial {
                return;
            }
            match result {
                Ok(list) => {
                    s.tracks = Some(list.unwrap_or_default());
                    s.error = None;
                }
                Err(e) => {
                    s.error = Some(if e.status != 0 && !e.message.is_empty() { e.message } else { "Failed to load recent plays.".into() })
                }
            }
        },
    );
}

fn tracks(app: &App) -> &[TrackListItem] {
    app.pages.recent.tracks.as_deref().unwrap_or_default()
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let _ = cx;
    let s = &app.pages.recent;
    let list = s.tracks.as_deref();
    let count = list.map_or_else(|| "—".to_string(), |l| crate::format::pluralize(l.len(), "track"));
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
            actions: Some(play_list_button(t, "recent-play", "Play all", tracks, !playable).on_press(|app: &mut App| {
                let list = tracks(app).to_vec();
                crate::ui::track_row::start_list(app, &list, false);
            })),
            ..Default::default()
        },
    );
    let mut head = col().w_full().gap(18.0).child(header);
    if let Some(e) = &s.error {
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
