//! `MoveToAlbumDialog.tsx`: an admin tool that moves a track into an existing
//! album picked from a searchable list (no near-duplicate album from a typo).

use std::time::Duration;

use rune::{Cursor, El, Span, TextEdit, col, el, rich, row, text};

use super::{Which, reset};
use crate::api::{Album, TrackListItem};
use crate::app::App;
use crate::core::entity_labels::library_album_subtitle;
use crate::theme::Theme;
use crate::ui::forms::search_input;
use crate::ui::kit::{Dialog, error_banner, scroll_area_fit};
use crate::ui::{Btn, cover_art, font, line, tnum};

pub fn open(app: &mut App, track: &TrackListItem) {
    reset(app, Which::Move);
    let s = &mut app.overlays.edit;
    s.move_track = Some(track.clone());
    s.query = TextEdit::new("");
    s.query.focused = true;
    search(app);
}

/// The album list for the query: at once when it's empty, else after 220 ms.
fn search(app: &mut App) {
    let s = &mut app.overlays.edit;
    s.albums = None;
    s.search_gen += 1;
    let id = s.search_gen;
    let q = s.query.text.trim().to_string();
    if q.is_empty() {
        fetch(app, id, q);
        return;
    }
    app.net.after(Duration::from_millis(220), move |app| {
        if app.overlays.edit.search_gen == id {
            fetch(app, id, q);
        }
    });
}

fn fetch(app: &mut App, id: u64, q: String) {
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || {
            let params = crate::api::PageParams { limit: Some(50), q: (!q.is_empty()).then_some(q), ..Default::default() };
            crate::api::library::list_albums(&client, &params).map(|(a, _)| a)
        },
        move |app, result| {
            let s = &mut app.overlays.edit;
            if s.search_gen != id {
                return;
            }
            match result {
                Ok(list) => s.albums = Some(list),
                Err(e) => {
                    s.albums = Some(Vec::new());
                    s.error = Some(crate::overlays::error_message(&e, "Couldn't load albums."));
                }
            }
        },
    );
}

fn move_to(app: &mut App, album: Album) {
    let Some(client) = app.client.clone() else { return };
    let s = &mut app.overlays.edit;
    let Some(track) = s.move_track.clone() else { return };
    if s.moving_id.is_some() || track.album_id.as_deref() == Some(album.id.as_str()) {
        return;
    }
    s.moving_id = Some(album.id.clone());
    s.error = None;
    let nonce = s.nonce;
    app.net.run(
        move || crate::api::library::update_track(&client, &track.id, &crate::api::library::move_to_album_patch(&album.id)),
        move |app, result| {
            let s = &mut app.overlays.edit;
            if s.nonce != nonce {
                return;
            }
            s.moving_id = None;
            match result {
                Ok(_) => {
                    crate::pages::library_changed(app);
                    super::close(app);
                }
                Err(e) => s.error = Some(crate::overlays::error_message(&e, "Move failed.")),
            }
        },
    );
}

pub fn view(app: &App, t: &Theme, window: [f32; 2]) -> El {
    let s = &app.overlays.edit;
    let mut body = col().w_full().padding(16.0).gap(12.0);
    if let Some(track) = &s.move_track {
        let lead = "Moving ";
        let rest = match track.album_title.as_deref().filter(|a| !a.is_empty()) {
            Some(al) => format!(" — currently in {al}"),
            None => " — not in an album yet".to_string(),
        };
        let full = format!("{lead}{}{rest}", track.title);
        let a = lead.len();
        let b = a + track.title.len();
        body = body.child(
            rich(full, vec![Span::new(a, b).weight(500.0).color(t.c.foreground)])
                .font(font(14.0, 400.0))
                .color(t.c.muted_foreground)
                .wrap(),
        );
    }
    // `.search`: 320 px, at most 40% of the window.
    let search_w = 320.0f32.min(window[0] * 0.4);
    body = body.child(search_input(t, "move-album-search", &s.query, "Search albums", Some(search_w), |f| {
        f.on_edit(|a: &mut App| &mut a.overlays.edit.query).on_input_change(move |app: &mut App, _| search(app))
    }));
    let mut list = col().w_full().gap(2.0);
    let note = |msg: &str| el().padding(8.0).child(text(msg.to_string()).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground));
    match &s.albums {
        None => list = list.child(note("Loading…")),
        Some(v) if v.is_empty() => list = list.child(note("No albums match.")),
        Some(v) => {
            for a in v {
                let current = s.move_track.as_ref().and_then(|tr| tr.album_id.as_deref()) == Some(a.id.as_str());
                let busy = s.moving_id.as_deref() == Some(a.id.as_str());
                let art = crate::api::media::album_art(&a.id, Some(a.has_cover), None, None, Some(80), None);
                let mut b = row()
                    .key(format!("move-album-{}", a.id))
                    .w_full()
                    .padding(7.0)
                    .gap(10.0)
                    .items_center()
                    .radius(t.radius_lg())
                    .role("button")
                    .label(a.title.clone())
                    .child(cover_art(t, &app.images, if a.has_cover { art.as_deref() } else { None }, &a.title, 40.0, 40.0, 6.0))
                    .child(
                        col()
                            .grow(1.0)
                            .min_w(0.0)
                            .child(line(a.title.clone(), font(14.0, 500.0), t.c.popover_foreground))
                            .child(line(library_album_subtitle(a, true), tnum(font(12.0, 400.0)), t.c.muted_foreground)),
                    );
                if current {
                    b = b.child(text("Current").font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground));
                }
                if busy {
                    b = b.child(text("…").font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground));
                }
                let dim = current || (s.moving_id.is_some() && !busy);
                if dim {
                    b = b.opacity(0.5);
                }
                b = if current || s.moving_id.is_some() {
                    b.disabled(true)
                } else {
                    let album = a.clone();
                    b.hover(t.c.ghost_hover).cursor(Cursor::Pointer).focusable(true).on_press(move |app: &mut App| move_to(app, album.clone()))
                };
                list = list.child(b);
            }
        }
    }
    body = body.child(scroll_area_fit(t, "move-album-list", list.px(4.0), false, Some((window[1] * 0.44).floor())).mx(-4.0));
    if let Some(e) = &s.error {
        body = body.child(error_banner(t, e));
    }
    body = body.child(
        row()
            .w_full()
            .pt(4.0)
            .justify_end()
            .child(Btn::new("move-album-cancel", "Cancel").ghost().disabled(s.moving_id.is_some()).build(t).on_press(super::dismiss)),
    );
    Dialog::new("move-album", body).title("Move to album").build(t, window, super::dismiss)
}
