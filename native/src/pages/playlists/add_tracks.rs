//! `AddTracksDialog.tsx`: search the library (and TIDAL), tick tracks, add
//! them to the playlist.

use std::collections::HashSet;

use rune::{Cursor, El, KeyEvent, Tx, col, el, row, text};

use crate::api::{TrackListItem, TrackSource};
use crate::app::App;
use crate::format::{display_text, fmt_duration_ms};
use crate::images::{Cover, Fit};
use crate::theme::Theme;
use crate::ui::forms::search_input;
use crate::ui::kit::{Dialog, scroll_area_fit};
use crate::ui::{Btn, css_border_bottom, font, line, load_when_shown, tnum};

use super::detail::{self, detail, detail_mut};
use super::logic::error_message;

/// The dialog's state, kept for the visit (it stays mounted, closed).
#[derive(Default)]
pub struct State {
    pub open: bool,
    pub tracks: Vec<TrackListItem>,
    pub selected: HashSet<String>,
    pub error: Option<String>,
    pub busy: bool,
    /// The newest search; older answers are dropped.
    seq: u64,
}

fn state(app: &App) -> Option<&State> {
    detail(app).map(|d| &d.add)
}

/// "Add tracks": open the dialog and list the library (or search).
pub fn open(app: &mut App) {
    let Some(d) = detail_mut(app) else { return };
    d.add.open = true;
    app.pages.playlists.fields.add_query.focused = true;
    fetch(app);
}

fn close(app: &mut App) {
    if let Some(d) = detail_mut(app) {
        d.add.open = false;
        d.add.seq += 1;
    }
}

/// Search 150 ms after the last keystroke.
fn query_changed(app: &mut App) {
    let Some(d) = detail_mut(app) else { return };
    d.add.seq += 1;
    let (mount, seq) = (d.mount, d.add.seq);
    let sender = app.net.sender();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        sender.send(move |app| {
            if detail(app).is_some_and(|d| d.mount == mount && d.add.seq == seq && d.add.open) {
                fetch(app);
            }
        });
    });
}

fn fetch(app: &mut App) {
    let q = app.pages.playlists.fields.add_query.text.trim().to_string();
    let Some(d) = detail_mut(app) else { return };
    d.add.seq += 1;
    let (mount, seq) = (d.mount, d.add.seq);
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || {
            if q.is_empty() {
                crate::api::library::list_tracks(&client, &crate::api::PageParams { limit: Some(200), ..Default::default() }).map(|(t, _)| (t, None))
            } else {
                crate::api::search::search_tracks(
                    &client,
                    &crate::api::search::SearchParams {
                        page: crate::api::PageParams { limit: Some(50), q: Some(q.clone()), ..Default::default() },
                        ..Default::default()
                    },
                )
                .map(|r| (r.tracks, (!r.warnings.is_empty()).then(|| r.warnings.join(" "))))
            }
        },
        move |app, result| {
            let Some(d) = detail_mut(app).filter(|d| d.mount == mount && d.add.seq == seq) else { return };
            match result {
                Ok((tracks, warning)) => {
                    d.add.tracks = tracks;
                    d.add.error = warning;
                }
                Err(e) => {
                    d.add.tracks.clear();
                    d.add.error = Some(error_message(&e, "Search failed."));
                }
            }
        },
    );
}

fn toggle(app: &mut App, id: &str) {
    if let Some(d) = detail_mut(app)
        && !d.add.selected.remove(id)
    {
        d.add.selected.insert(id.to_string());
    }
}

fn submit(app: &mut App) {
    let Some(d) = detail_mut(app) else { return };
    if d.add.selected.is_empty() || d.add.busy {
        return;
    }
    d.add.busy = true;
    d.add.error = None;
    let ids: Vec<String> = d.add.selected.iter().cloned().collect();
    let (id, mount) = (d.id.clone(), d.mount);
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || crate::api::playlists::add_playlist_tracks(&client, &id, &ids),
        move |app, result| {
            let Some(d) = detail_mut(app).filter(|d| d.mount == mount) else { return };
            match result {
                Ok(()) => {
                    // The web dialog stays busy with its ticks after a
                    // success; it reopens fresh here instead.
                    d.add.busy = false;
                    d.add.selected.clear();
                    d.add.open = false;
                    detail::load(app, None);
                }
                Err(e) => {
                    d.add.busy = false;
                    d.add.error = Some(error_message(&e, "Failed to add tracks."));
                }
            }
        },
    );
}

/// Whether `t` is in the playlist already, under any of its ids.
fn is_existing(t: &TrackListItem, existing: &HashSet<String>) -> bool {
    let has = |id: String| existing.contains(id.as_str());
    if existing.contains(t.id.as_str()) {
        return true;
    }
    if let Some(db) = &t.db_track_id {
        if existing.contains(db.as_str()) {
            return true;
        }
        if t.source == Some(TrackSource::Local) && has(format!("local:{db}")) {
            return true;
        }
    }
    match (&t.source, &t.source_id) {
        (Some(TrackSource::Local), Some(s)) => has(format!("local:{s}")),
        (Some(TrackSource::Tidal), Some(s)) => has(format!("tidal:{s}")),
        _ => false,
    }
}

/// The `.mini-art` tile outside a table: the cover at its own size, its
/// top-left corner showing (no `background-size` applies there). Only that
/// corner is decoded, and only once the row shows: the list holds up to 200
/// tracks, and their whole covers (up to 1 MB each) overflowed the decoded
/// budget, so each arrival evicted another the dialog still drew and asked
/// for again, redrawing the window forever.
fn mini_art(app: &App, url: &str) -> El {
    let fit = Fit::Corner(32, 32);
    let state = app.images.get_lazy(url, fit);
    let mut tile = load_when_shown(el().size(32.0, 32.0).clip_rounded(0.0), &state, Some(url), fit);
    if let Cover::Ready(img) = state {
        let [w, h] = img.size().unwrap_or([32, 32]);
        tile = tile.child(el().size(w as f32, h as f32).absolute(0.0, 0.0).pixels_fit(img.pixels(), rune::SurfaceFit::Fill));
    }
    tile
}

fn track_row(app: &App, t: &Theme, tr: &TrackListItem, existing: &HashSet<String>, selected: bool) -> El {
    let disabled = is_existing(tr, existing);
    let mut sub = display_text(tr.artist.as_deref(), "Unknown");
    if let Some(a) = tr.album_title.as_deref().filter(|a| !a.is_empty()) {
        sub.push_str(&format!(" - {}", display_text(Some(a), "")));
    }
    if tr.source == Some(TrackSource::Tidal) {
        sub.push_str(" - TIDAL");
    }
    if disabled {
        sub.push_str(" - already added");
    }
    let url = tr.cover_at(None);
    let id = tr.id.clone();
    let mut r = row()
        .key(format!("add-track-{}", tr.id))
        .w_full()
        .px(4.0)
        .pt(8.0)
        .pb(9.0)
        .gap(12.0)
        .items_center()
        .role("checkbox")
        .checked(selected)
        .label(display_text(Some(&tr.title), ""))
        .child(crate::ui::native::checkbox(t, selected))
        .child(mini_art(app, &url))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .child(line(display_text(Some(&tr.title), ""), font(14.0, 500.0), t.c.popover_foreground).h(20.3))
                .child(line(sub, tnum(font(12.0, 400.0)), t.c.muted_foreground).h(17.4)),
        )
        .child(text(fmt_duration_ms(tr.duration_ms)).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground));
    r = css_border_bottom(r, 1.0, t.c.border);
    if disabled {
        r.opacity(0.5).cursor(Cursor::NotAllowed).disabled(true)
    } else {
        r.hover(t.c.ghost_hover).cursor(Cursor::Pointer).focusable(true).on_press(move |app: &mut App| toggle(app, &id))
    }
}

/// The dialog, while open.
pub fn view(app: &App, t: &Theme, cx: &mut rune::Cx<App>, window: [f32; 2]) -> Option<El> {
    let d = detail(app)?;
    let s = state(app).filter(|s| s.open)?;
    let existing = &d.ids;
    let search = search_input(t, "add-tracks-search", &app.pages.playlists.fields.add_query, "Search local + TIDAL", Some(320.0), |f| {
        f.label("Search tracks")
            .on_edit(|a: &mut App| &mut a.pages.playlists.fields.add_query)
            .on_input_change(|a: &mut App, _| query_changed(a))
            .on_input_key(|a: &mut App, ev: &KeyEvent, _tx: &mut Tx| {
                if ev.key == rune::Key::Escape {
                    close(a);
                    return true;
                }
                false
            })
    });
    let mut list = col().w_full().mt(12.0);
    for tr in &s.tracks {
        list = list.child(track_row(app, t, tr, existing, s.selected.contains(&tr.id)));
    }
    // The panel is at most 80% of the window: its borders, the 57 px header
    // and the 61 px footer leave the rest to the list.
    let max_body = (window[1] * 0.8 - 2.0 - 57.0 - 61.0).max(80.0);
    let overflows = cx.layout_size("add-tracks-body").is_some_and(|b| b[1] > max_body + 0.5);
    let content = col().key("add-tracks-body").w_full().padding(18.0).child(search).child(list);
    let body = scroll_area_fit(t, "add-tracks-scroll", content, overflows, Some(max_body));
    let mut start = row().grow(1.0).gap(8.0).items_center().child(
        text(format!("{} selected", s.selected.len())).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground),
    );
    if let Some(e) = &s.error {
        start = start.child(row().grow(1.0).justify_end().child(text(e.clone()).font(font(12.0, 400.0)).color(t.c.destructive).role("alert")));
    }
    let cancel = Btn::new("add-tracks-cancel", "Cancel").ghost().disabled(s.busy).build(t);
    let cancel = if s.busy { cancel } else { cancel.on_press(close) };
    let can_add = !s.busy && !s.selected.is_empty();
    let add = Btn::new("add-tracks-submit", if s.busy { "Adding...".to_string() } else { format!("Add {}", s.selected.len()) })
        .primary()
        .disabled(!can_add)
        .build(t);
    let add = if can_add { add.on_press(submit) } else { add };
    let footer = crate::ui::css_border_top(row(), 1.0, t.c.border)
        .w_full()
        .px(18.0)
        .pt(15.0)
        .pb(14.0)
        .gap(12.0)
        .items_center()
        .justify_between()
        .child(start)
        .child(row().gap(8.0).items_center().child(cancel).child(add));
    Some(Dialog::new("add-tracks", body).title("Add tracks").max_width(560.0).footer(footer).build(t, window, close))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn already_added_under_any_id() {
        let existing: HashSet<String> = ["t1", "local:42", "tidal:9"].into_iter().map(String::from).collect();
        let track = |id: &str, db: Option<&str>, source: TrackSource, source_id: Option<&str>| TrackListItem {
            id: id.into(),
            db_track_id: db.map(Into::into),
            source: Some(source),
            source_id: source_id.map(Into::into),
            ..Default::default()
        };
        assert!(is_existing(&track("t1", None, TrackSource::Local, None), &existing));
        assert!(is_existing(&track("x", Some("42"), TrackSource::Local, None), &existing));
        assert!(is_existing(&track("x", None, TrackSource::Tidal, Some("9")), &existing));
        assert!(!is_existing(&track("x", Some("9"), TrackSource::Tidal, None), &existing));
        assert!(!is_existing(&track("x", None, TrackSource::Local, Some("9")), &existing));
    }
}
