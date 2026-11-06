//! `TrackInfoDialog.tsx`, `context/TrackInfo.tsx` (`dialogs.css`): a
//! read-only view of one track, laid out landscape. The cover, title,
//! artists and album take the left third; Credits, Release and Audio and the
//! other copies' tags fill the right two thirds, each side scrolling on its
//! own. A TIDAL track's fields also come live from TIDAL. Admins link other
//! library files of the same song from here.
mod multi_select;
pub mod rows;
mod versions;

use rune::{Cx, El, TextEdit, col, el, row, text};

use self::rows::{Row, Tidal, display_artists, display_text, track_info_rows};
use crate::api::{TrackDetail, TrackListItem, TrackSource};
use crate::app::App;
use crate::overlays::requests;
use crate::theme::Theme;
use crate::ui::kit::{Dialog, eyebrow, scroll_area_fit};
use crate::ui::{cover_art, font, snug_lines, with_lh};

#[derive(Default)]
pub struct State {
    /// The track the dialog is open for.
    pub track_id: Option<String>,
    /// Counts openings, so a slow answer for an earlier one drops.
    nonce: u64,
    pub track: Option<TrackDetail>,
    pub error: Option<String>,
    /// TIDAL's details for a TIDAL track; None while they load.
    pub tidal: Option<Tidal>,
    /// Links and unlinks this opening has seen.
    pub relinks: u32,
    // Versions
    pub picked: Option<Vec<usize>>,
    pub picker_open: bool,
    pub linking: bool,
    pub unlinking: Option<String>,
    pub version_error: Option<String>,
    pub query: TextEdit,
    pub results: Option<(String, Vec<TrackListItem>)>,
    pub linker_error: Option<String>,
    pub linking_id: Option<String>,
    search_gen: u64,
}

/// Open the dialog for a track id (`useTrackInfo().open(trackId)`).
pub fn open(app: &mut App, track_id: &str) {
    let nonce = app.overlays.track_info.nonce + 1;
    app.overlays.track_info = State { track_id: Some(track_id.to_string()), nonce, ..Default::default() };
    let Some(client) = app.client.clone() else { return };
    let id = track_id.to_string();
    app.net.run(
        move || {
            // `useTrackDetail` gives up after 15 s.
            let started = std::time::Instant::now();
            let r = requests::track(&client, &id);
            (r, started.elapsed() > std::time::Duration::from_secs(15))
        },
        move |app, (result, timed_out)| {
            let s = &mut app.overlays.track_info;
            if s.nonce != nonce {
                return;
            }
            match result {
                _ if timed_out => s.error = Some("Track info request timed out.".into()),
                Ok(t) => {
                    let tidal = (t.source == TrackSource::Tidal).then(|| t.source_id.clone()).flatten();
                    s.track = Some(t);
                    match tidal {
                        Some(id) => load_tidal(app, id, nonce),
                        None => app.overlays.track_info.tidal = Some(Tidal::default()),
                    }
                }
                Err(e) => s.error = Some(super::error_message(&e, "Failed to load track.")),
            }
        },
    );
}

/// [`open`] for a track row.
pub fn open_track(app: &mut App, track: &TrackListItem) {
    open(app, &track.id);
}

fn load_tidal(app: &mut App, id: String, nonce: u64) {
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || {
            let r = requests::tidal_track(&client, &id);
            (id, r)
        },
        move |app, (id, result)| {
            let s = &mut app.overlays.track_info;
            if s.nonce != nonce {
                return;
            }
            s.tidal = Some(match result {
                Ok(info) if info.id == id => Tidal { info: Some(info), failed: false, refusal: None },
                Ok(_) => Tidal { info: None, failed: true, refusal: None },
                Err(e) => {
                    // `tidalRefusalMessage`: TIDAL's own reason, always a 502.
                    let refusal = (e.status == 502 && e.message.starts_with("TIDAL refused")).then(|| e.message.clone());
                    Tidal { info: None, failed: true, refusal }
                }
            });
        },
    );
}

pub fn close(app: &mut App) {
    let s = &mut app.overlays.track_info;
    s.track_id = None;
    s.picker_open = false;
}

/// Escape inside the linker cancels the search; otherwise it closes.
fn escape(app: &mut App) {
    let s = &mut app.overlays.track_info;
    if s.picker_open {
        s.picker_open = false;
    } else if s.linking {
        if s.linking_id.is_none() {
            s.linking = false;
        }
    } else {
        close(app);
    }
}

/// `libraryChanged.emit()` after a link or unlink.
fn library_changed(app: &mut App) {
    // TODO(pages-merge): the pages' library-changed hook.
    let loc = app.location().clone();
    crate::pages::enter(app, &loc);
}

/// The left third: artwork and the lines a player shows.
fn summary(app: &App, t: &Theme, track: Option<&TrackDetail>, w: f32) -> El {
    let size = (w - 41.0).max(0.0);
    let mut c = col().w(w).pt(20.0).pb(20.0).pl(20.0).pr(21.0).gap(16.0);
    match track {
        Some(tr) => {
            let art = crate::api::media::track_art(&tr.id, tr.album_id.as_deref(), tr.cover_url.as_deref(), Some(tr.has_cover), Some(512));
            c = c.child(cover_art(t, &app.images, art.as_deref(), &tr.title, size, size, t.radius_lg()));
            let artists = {
                let a = display_artists(tr);
                if a.is_empty() { super::share::primary_artist(tr, "Unknown artist") } else { a }
            };
            let mut heading = col()
                .w_full()
                .gap(2.0)
                .child(
                    snug_lines(
                        "track-info-title",
                        text(display_text(Some(&tr.title), "")).font(with_lh(font(20.0, 600.0), 25.0)).color(t.c.popover_foreground).wrap_anywhere(),
                        25.0,
                    )
                    .mb(2.0),
                )
                .child(snug_lines("track-info-artist", text(artists).font(font(14.0, 400.0)).color(t.c.muted_foreground).wrap_anywhere(), 20.3));
            if let Some(al) = tr.album_title.as_deref().filter(|a| !a.is_empty()) {
                heading = heading.child(snug_lines(
                    "track-info-album",
                    text(display_text(Some(al), "")).font(with_lh(font(13.0, 400.0), 18.85)).color(t.c.muted_foreground).wrap_anywhere(),
                    18.85,
                ));
            }
            c = c.child(heading);
        }
        None => c = c.child(el().size(size, size).radius(t.radius_lg()).fill(t.c.muted)),
    }
    c
}

/// One labelled value (`dt` over `dd`).
fn field(t: &Theme, r: &Row, w: f32, key: &str) -> El {
    col()
        .w(w)
        .min_w(0.0)
        .child(text(r.label.clone()).font(font(12.0, 400.0)).color(t.c.muted_foreground).h(17.4))
        .child(
            snug_lines(key, text(r.value.clone()).font(font(14.0, 400.0)).color(if r.empty { t.c.muted_foreground } else { t.c.foreground }).wrap_anywhere(), 20.3)
                .mt(2.0),
        )
}

/// `.track-info-fields`: `repeat(auto-fill, minmax(112px, 1fr))` with 12 × 16
/// gaps, wide rows across the whole width.
fn fields(t: &Theme, section: &str, list: &[Row], width: f32) -> El {
    let cols = (((width + 16.0) / 128.0).floor() as usize).max(1);
    let col_w = (width - 16.0 * (cols as f32 - 1.0)) / cols as f32;
    let mut grid = col().w_full().gap(12.0);
    let mut line = row().gap(16.0).items_start();
    let mut in_line = 0;
    for (n, r) in list.iter().enumerate() {
        let key = format!("track-info-{section}-{n}");
        if r.wide {
            if in_line > 0 {
                grid = grid.child(line);
                line = row().gap(16.0).items_start();
                in_line = 0;
            }
            grid = grid.child(field(t, r, width, &key));
            continue;
        }
        line = line.child(field(t, r, col_w, &key));
        in_line += 1;
        if in_line == cols {
            grid = grid.child(line);
            line = row().gap(16.0).items_start();
            in_line = 0;
        }
    }
    if in_line > 0 {
        grid = grid.child(line);
    }
    grid
}

fn note(t: &Theme, msg: &str, key: &str) -> El {
    snug_lines(key, text(msg.to_string()).font(font(12.0, 400.0)).color(t.c.muted_foreground).wrap(), 17.4)
}

fn details(app: &App, t: &Theme, width: f32) -> El {
    let s = &app.overlays.track_info;
    let inner = width - 48.0;
    let mut c = col().w(width).pt(20.0).pb(20.0).px(24.0).gap(20.0);
    if let Some(e) = &s.error {
        return c.child(text(e.clone()).font(font(14.0, 400.0)).color(t.c.destructive).wrap());
    }
    let (Some(track), Some(tidal)) = (&s.track, &s.tidal) else {
        return c.child(text("Loading…").font(font(14.0, 400.0)).color(t.c.muted_foreground));
    };
    let view = track_info_rows(track, (track.source == TrackSource::Tidal).then_some(tidal));
    if let Some(n) = &view.note {
        c = c.child(note(t, n, "track-info-note"));
    }
    for sec in &view.sections {
        let mut b = col().w_full().child(eyebrow(t, sec.label).h(17.4).mb(8.0).role("heading")).child(fields(t, sec.label, &sec.rows, inner));
        if let Some(n) = &sec.note {
            b = b.child(note(t, n, &format!("track-info-note-{}", sec.label)).mt(8.0));
        }
        c = c.child(b);
    }
    let is_admin = app.me().is_some_and(|m| m.is_admin());
    let can_link = is_admin && track.source == TrackSource::Local && track.owned != Some(true);
    if !track.aliases.is_empty() || !track.linked.is_empty() || can_link {
        c = c.child(versions::view(app, t, track, can_link, inner));
    }
    c
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let s = &app.overlays.track_info;
    s.track_id.as_ref()?;
    let window = super::window_size(cx);
    let panel_w = 880.0f32.min(window[0] - 32.0);
    let inner = panel_w - 2.0;
    let summary_w = inner / 3.0;
    let details_w = inner - summary_w;
    // The body's height: what's left of 80% of the window under the header.
    let max_h = (window[1] * 0.8 - 2.0 - 57.0).max(80.0);
    let summary_h = cx.layout_size("track-info-summary").map(|s| s[1]);
    let details_h = cx.layout_size("track-info-details").map(|s| s[1]);
    let summary_over = summary_h.is_some_and(|h| h > max_h + 0.5);
    let details_over = details_h.is_none_or(|h| h > max_h + 0.5);
    let left = scroll_area_fit(t, "track-info-summary-scroll", summary(app, t, s.track.as_ref(), summary_w - if summary_over { 10.0 } else { 0.0 }).key("track-info-summary"), summary_over, Some(max_h))
        .w(summary_w)
        .child(el().pin(None, Some(0.0), Some(0.0), Some(0.0)).w(1.0).fill(t.c.border).inert());
    let right = scroll_area_fit(
        t,
        "track-info-details-scroll",
        details(app, t, details_w - if details_over { 10.0 } else { 0.0 }).key("track-info-details"),
        details_over,
        Some(max_h),
    )
    .w(details_w);
    let body = row().w_full().items_stretch().child(left).child(right);
    Some(Dialog::new("track-info", body).title("Track info").max_width(880.0).build(t, window, escape))
}

/// The versions picker's list, above the dialog.
pub fn picker_view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    app.overlays.track_info.track_id.as_ref()?;
    versions::picker_layer(app, t, cx)
}
