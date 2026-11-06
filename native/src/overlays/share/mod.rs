//! `ShareDialog.tsx`, `context/Share.tsx` and `components/share/*`
//! (`PreviewStrip`, `CopyLinkButton`, `useShareLink`, `useSnippetPreview`):
//! pick a window of a track and copy a link that unfurls into a chat video
//! embed (cover + audio snippet), or save that video. Copy stays disabled
//! until the window has been moved or trimmed once, so the default is never
//! shared by accident.
pub mod snippet;
mod strip;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use rune::{Color, Cx, El, Tx, col, el, row, text};

use self::snippet::Grab;
use super::requests;
use crate::api::{TrackDetail, TrackListItem};
use crate::app::App;
use crate::format::{fmt_duration_ms, fmt_duration_sec};
use crate::theme::Theme;
use crate::ui::kit::{Dialog, dialog_footer, eyebrow};
use crate::ui::{Btn, cover_art, css_border, font, icons as i, line, mono, tnum, with_lh};

#[derive(Default)]
pub struct State {
    /// The track the dialog is open for.
    pub track_id: Option<String>,
    pub track: Option<TrackDetail>,
    pub load_error: Option<String>,
    pub start: f64,
    pub selected: f64,
    /// The window has been moved or trimmed.
    pub picked: bool,
    /// The link for the current window, once minted.
    pub share_url: Option<String>,
    /// The window the last mint was for ("id:start:duration").
    minted_for: Option<String>,
    pub busy: bool,
    pub copied: bool,
    copy_gen: u64,
    pub copy_error: Option<String>,
    pub downloading: bool,
    pub download_error: Option<String>,
    pub playing: bool,
    pub current: f64,
    /// What a press on the strip grabbed, and where on it.
    drag: Option<(Grab, f64)>,
    /// Bumped as the dialog opens or the window moves, so late answers drop.
    gen_: Arc<AtomicU64>,
}

/// Open the dialog for a track id (`useShare().open(trackId)`).
pub fn open(app: &mut App, track_id: &str) {
    let gen_ = app.overlays.share.gen_.clone();
    gen_.fetch_add(1, Ordering::Relaxed);
    app.overlays.share = State {
        track_id: Some(track_id.to_string()),
        selected: snippet::DEFAULT_DURATION_SEC,
        gen_,
        ..Default::default()
    };
    load(app, track_id.to_string());
}

/// [`open`] for a track row.
pub fn open_track(app: &mut App, track: &TrackListItem) {
    open(app, &track.id);
}

pub fn close(app: &mut App) {
    let s = &mut app.overlays.share;
    s.gen_.fetch_add(1, Ordering::Relaxed);
    s.track_id = None;
    s.playing = false;
}

fn dismiss(app: &mut App) {
    if !app.overlays.share.busy {
        close(app);
    }
}

fn load(app: &mut App, id: String) {
    let Some(client) = app.client.clone() else { return };
    let gen_ = app.overlays.share.gen_.load(Ordering::Relaxed);
    app.net.run(
        move || requests::track(&client, &id),
        move |app, result| {
            let s = &mut app.overlays.share;
            if s.gen_.load(Ordering::Relaxed) != gen_ {
                return;
            }
            match result {
                Ok(t) => s.track = Some(t),
                Err(e) => s.load_error = Some(super::error_message(&e, "Failed to load track.")),
            }
        },
    );
}

fn track_secs(s: &State) -> f64 {
    s.track.as_ref().map_or(0.0, |t| t.duration_ms as f64 / 1000.0)
}

/// `onWindowChange`: store the window rounded and clamped; any link minted
/// for the old window no longer applies.
fn set_window(app: &mut App, start: f64, duration: f64) {
    let s = &mut app.overlays.share;
    let (start, duration) = snippet::normalize(track_secs(s), start, duration);
    if s.picked && s.start == start && s.selected == duration {
        return;
    }
    s.start = start;
    s.selected = duration;
    s.picked = true;
    s.share_url = None;
    s.minted_for = None;
    s.copied = false;
    s.gen_.fetch_add(1, Ordering::Relaxed);
}

fn window(s: &State) -> snippet::Window {
    snippet::window(track_secs(s), s.selected, s.start)
}

/// `ensureUrl`: the link for this window, minted once.
fn ensure_url(app: &mut App, then: impl FnOnce(&mut App, Result<String, String>) + Send + 'static, fallback: &'static str) {
    let s = &app.overlays.share;
    let Some(id) = s.track_id.clone() else { return };
    let w = window(s);
    let key = format!("{id}:{}:{}", s.start, w.effective_duration);
    if let (Some(url), Some(k)) = (&s.share_url, &s.minted_for)
        && *k == key
    {
        let url = url.clone();
        then(app, Ok(url));
        return;
    }
    let Some(client) = app.client.clone() else { return };
    let gen_ = s.gen_.clone();
    let at = gen_.load(Ordering::Relaxed);
    let (start, dur) = (s.start, w.effective_duration);
    app.net.run(
        move || requests::create_share_link(&client, &id, start, dur),
        move |app, result| {
            if gen_.load(Ordering::Relaxed) != at {
                return;
            }
            match result {
                Ok(link) => {
                    let s = &mut app.overlays.share;
                    s.share_url = Some(link.url.clone());
                    s.minted_for = Some(key);
                    then(app, Ok(link.url));
                }
                Err(e) => then(app, Err(super::error_message(&e, fallback))),
            }
        },
    );
}

fn copy(app: &mut App) {
    let s = &mut app.overlays.share;
    if s.track_id.is_none() || !s.picked || s.busy {
        return;
    }
    s.download_error = None;
    s.copy_error = None;
    s.busy = true;
    ensure_url(
        app,
        |app, result| {
            app.overlays.share.busy = false;
            match result {
                Ok(url) => super::later(app, move |app, tx| {
                    tx.copy(url);
                    flash_copied(app);
                }),
                Err(e) => app.overlays.share.copy_error = Some(e),
            }
        },
        "Couldn't copy link — try again or copy the URL manually.",
    );
}

/// `useCopiedFlag(1800)`.
fn flash_copied(app: &mut App) {
    let s = &mut app.overlays.share;
    s.copied = true;
    s.copy_gen += 1;
    let id = s.copy_gen;
    let wait = !app.net.is_sync();
    app.net.run(
        move || {
            if wait {
                std::thread::sleep(std::time::Duration::from_millis(1800));
            }
        },
        move |app, ()| {
            if app.overlays.share.copy_gen == id {
                app.overlays.share.copied = false;
            }
        },
    );
}

/// Save the window's preview video (the MP4 that unfurls in chat).
fn download_video(app: &mut App) {
    let s = &mut app.overlays.share;
    let Some(track) = s.track.clone() else { return };
    if !s.picked || s.busy || s.downloading {
        return;
    }
    s.downloading = true;
    s.download_error = None;
    s.copy_error = None;
    let artist = primary_artist(&track, "");
    let file_name = format!("{}.mp4", snippet::clip_name(&artist, &track.title));
    ensure_url(
        app,
        move |app, result| {
            let reference = result.and_then(|u| snippet::parse_share_url(&u).ok_or_else(|| "Couldn't read the generated share link.".to_string()));
            match reference {
                Err(e) => {
                    let s = &mut app.overlays.share;
                    s.download_error = Some(e);
                    s.downloading = false;
                }
                Ok(r) => super::later(app, move |_app, tx: &mut Tx| {
                    let options = rune::FileDialogOptions { title: "Save video".into(), file_name: Some(file_name), ..Default::default() }
                        .filter("Video", &["mp4"]);
                    tx.save_file(options, move |app: &mut App, picked, _| match picked {
                        Ok(Some(path)) => save_video(app, &r, path),
                        _ => app.overlays.share.downloading = false,
                    });
                }),
            }
        },
        "Couldn't download the video — try again.",
    );
}

fn save_video(app: &mut App, r: &snippet::ShareRef, path: std::path::PathBuf) {
    let Some(client) = app.client.clone() else { return };
    let url = snippet::preview_video_path(r);
    app.net.run(
        move || {
            let (bytes, _) = client.bytes(&url).map_err(|e| super::error_message(&e, "Couldn't download the video — try again."))?;
            std::fs::write(&path, bytes).map_err(|e| e.to_string())
        },
        |app, result: Result<(), String>| {
            let s = &mut app.overlays.share;
            s.downloading = false;
            if let Err(e) = result {
                s.download_error = Some(e);
            }
        },
    );
}

/// Play the window end to end, as the embed will.
// TODO(player-merge): route this through the audio engine (the track's
// stream from `start` to `end`); until then the playhead runs silent.
fn toggle_play(app: &mut App) {
    let s = &mut app.overlays.share;
    if s.playing {
        s.playing = false;
        return;
    }
    let w = window(s);
    s.playing = true;
    s.current = s.start;
    if app.net.is_sync() {
        return;
    }
    let (start, end) = (s.start, w.end);
    let gen_ = s.gen_.clone();
    let at = gen_.load(Ordering::Relaxed);
    let sender = app.net.sender();
    std::thread::spawn(move || {
        let began = std::time::Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let now = start + began.elapsed().as_secs_f64();
            let (tx, rx) = std::sync::mpsc::channel();
            let gen_ = gen_.clone();
            sender.send(move |app: &mut App| {
                let s = &mut app.overlays.share;
                let live = s.playing && gen_.load(Ordering::Relaxed) == at;
                if live {
                    if now >= end {
                        s.playing = false;
                        s.current = start;
                    } else {
                        s.current = now;
                    }
                }
                let _ = tx.send(live && now < end);
            });
            if rx.recv_timeout(std::time::Duration::from_secs(5)) != Ok(true) {
                break;
            }
        }
    });
}

/// `primaryArtistName`.
pub fn primary_artist(t: &TrackDetail, fallback: &str) -> String {
    t.artists
        .iter()
        .find(|a| a.role == "primary")
        .or(t.artists.first())
        .map_or(fallback.to_string(), |a| a.name.clone())
}

fn header(app: &App, t: &Theme, track: &TrackDetail) -> El {
    let cover = track.has_cover.then(|| crate::api::media::track_cover(&track.id, track.album_id.as_deref(), track.cover_url.as_deref(), None));
    let mut sub = primary_artist(track, "Unknown artist");
    if let Some(a) = track.album_title.as_deref().filter(|a| !a.is_empty()) {
        sub.push_str(&format!(" · {a}"));
    }
    row()
        .w_full()
        .gap(12.0)
        .items_center()
        .child(cover_art(t, &app.images, cover.as_deref(), &track.title, 64.0, 64.0, 10.0))
        .child(
            col()
                .min_w(0.0)
                .shrink()
                .child(line(track.title.clone(), font(14.0, 600.0), t.c.foreground).h(20.3))
                .child(line(sub, font(12.0, 400.0), t.c.muted_foreground).h(17.4))
                .child(text(fmt_duration_ms(track.duration_ms)).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground).h(17.4).mt(2.0)),
        )
}

/// The copy button's label: its three states share the widest one's width.
const COPY_LABELS: [&str; 3] = ["Copy share link", "Generating share link…", "Link copied"];

fn copy_button(t: &Theme, s: &State, disabled: bool) -> El {
    let shown = if s.busy { 1 } else if s.copied { 2 } else { 0 };
    let ink = t.c.primary_foreground;
    let glyph = match shown {
        1 => spinner(ink),
        2 => crate::ui::ico(&i::CHECK, 14.0, ink),
        _ => crate::ui::ico(&i::CLIPBOARD_COPY, 14.0, ink),
    };
    // All three labels in one cell: the widest holds the width, the shown one draws.
    let mut stack = el();
    for (n, l) in COPY_LABELS.iter().enumerate() {
        let label = text(*l).font(font(14.0, 500.0)).color(ink);
        stack = if n == 1 {
            stack.child(label.opacity(if shown == n { 1.0 } else { 0.0 }))
        } else {
            stack.child(
                row().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).justify_center().items_center().child(label.opacity(if shown == n {
                    1.0
                } else {
                    0.0
                })),
            )
        };
    }
    let fill = t.c.primary;
    let mut b = row()
        .key("share-copy")
        .h(32.0)
        .px(11.0)
        .gap(6.0)
        .items_center()
        .justify_center()
        .radius(t.radius_lg())
        .fill(fill)
        .role("button")
        .label(COPY_LABELS[shown])
        .child(glyph)
        .child(stack);
    if disabled {
        b = b.opacity(0.5).disabled(true).cursor(rune::Cursor::NotAllowed);
    } else {
        b = b.hover(t.c.background.alpha(0.2)).press_scale(0.97).cursor(rune::Cursor::Pointer).focusable(true).on_press(copy);
    }
    b
}

/// `IosSpinner` at 14 px: twelve bars, fading round.
fn spinner(color: Color) -> El {
    let mut s = el().size(14.0, 14.0).label("Generating").role("progressbar");
    for n in 0..12 {
        let angle = n as f32 * std::f32::consts::PI / 6.0;
        s = s.child(
            el().pin(Some(7.0 - 1.1), Some(1.0), None, None)
                .size(2.2, 7.0)
                .radius(999.0)
                .fill(color)
                .opacity(0.25 + 0.75 * (n as f32 / 11.0))
                .origin(0.5, (7.0 - 1.0) / 7.0)
                .rotate(angle),
        );
    }
    s.looping(rune_motion::LoopSpec::rotation(1.0))
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let s = &app.overlays.share;
    s.track_id.as_ref()?;
    let window_size = super::window_size(cx);
    let body = if let Some(e) = &s.load_error {
        el().padding(16.0).child(text(e.clone()).font(font(14.0, 400.0)).color(t.c.destructive).wrap())
    } else if let Some(track) = &s.track {
        let dur = track_secs(s);
        let w = window(s);
        let strip_w = cx.layout_size("share-strip").map_or(478.0, |r| r[0]);
        let mut b = col().w_full().padding(16.0).gap(14.0).child(header(app, t, track)).child(
            col()
                .w_full()
                .gap(7.0)
                .child(
                    row()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .child(text("Clip window").font(font(14.0, 400.0)).color(t.c.muted_foreground).h(20.3))
                        .child(text(fmt_duration_sec(w.display_duration)).font(tnum(font(14.0, 400.0))).color(t.c.popover_foreground).h(20.3)),
                )
                .child(strip::view(t, s, dur, w, strip_w))
                .child(
                    row()
                        .w_full()
                        .gap(12.0)
                        .items_center()
                        .justify_between()
                        .child(
                            text("Drag edges to resize · drag middle to move")
                                .font(tnum(font(12.0, 400.0)))
                                .color(t.c.muted_foreground)
                                .h(17.4)
                                .shrink(),
                        )
                        .child(
                            text(format!(
                                "{} – {}{}",
                                fmt_duration_sec(s.start),
                                fmt_duration_sec(w.end),
                                if dur > 0.0 { format!(" · of {}", fmt_duration_sec(dur)) } else { String::new() }
                            ))
                            .font(tnum(font(12.0, 400.0)))
                            .color(t.c.muted_foreground)
                            .h(17.4),
                        ),
                ),
        );
        b = b.child(
            row()
                .w_full()
                .gap(8.0)
                .items_center()
                .child(
                    Btn::new("share-play", if s.playing { "Pause preview" } else { "Play preview" })
                        .small()
                        .icon(if s.playing { &i::PAUSE_FILLED } else { &i::PLAY_FILLED })
                        .build(t)
                        .on_press(toggle_play),
                )
                .child(
                    text(if s.picked { "Happy with the window? Copy the link." } else { "Trim the edges or drag the window into place." })
                        .font(tnum(font(12.0, 400.0)))
                        .color(t.c.muted_foreground)
                        .shrink(),
                ),
        );
        if let Some(url) = &s.share_url {
            b = b.child(
                css_border(col(), 1.0, t.c.border, t.radius_lg())
                    .w_full()
                    .padding(11.0)
                    .gap(6.0)
                    .radius(t.radius_lg())
                    .fill(t.c.muted)
                    .child(eyebrow(t, "Share link"))
                    .child(text(url.clone()).font(with_lh(mono(12.0, 400.0), 17.4)).color(t.c.foreground).wrap_anywhere()),
            );
        }
        if let Some(e) = s.copy_error.as_ref().or(s.download_error.as_ref()) {
            b = b.child(text(e.clone()).font(font(12.0, 400.0)).color(t.c.destructive).wrap().role("alert"));
        }
        b
    } else {
        el().padding(16.0).child(text("Loading…").font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground))
    };
    let track = s.track.is_some();
    let footer = dialog_footer(
        t,
        None,
        vec![
            Btn::new("share-close", "Close").ghost().disabled(s.busy).build(t).on_press(dismiss),
            Btn::new("share-download", "Download video")
                .icon(&i::DOWNLOAD)
                .disabled(!s.picked || s.busy || s.downloading || !track)
                .build(t)
                .on_press(download_video),
            copy_button(t, s, !s.picked || s.busy || !track),
        ],
    );
    Some(Dialog::new("share", body.key("share-body")).title("Share track").footer(footer).build(t, window_size, dismiss))
}

/// The strip's drag: grab an edge or the window, then follow the pointer.
pub(super) fn on_drag(app: &mut App, d: &rune::Drag) {
    let s = &mut app.overlays.share;
    let dur = track_secs(s);
    if dur <= 0.0 || d.w <= 0.0 {
        return;
    }
    let at = (d.x / d.w).clamp(0.0, 1.0) as f64 * dur;
    let w = window(s);
    match d.phase {
        rune::Phase::Down => {
            let (kind, offset) = snippet::drag_target(at, s.start, w.end, dur, d.w as f64);
            s.drag = Some((kind, offset));
        }
        rune::Phase::Up => {
            s.drag = None;
            return;
        }
        rune::Phase::Move => {}
    }
    let Some((kind, offset)) = s.drag else { return };
    let (start, duration) =
        snippet::adjust(kind, at - offset, s.start, w.end, dur, w.min_duration, w.max_duration, w.max_start);
    set_window(app, start, duration);
}

/// Arrow keys on the window (move it) and on its edges (trim).
pub(super) fn on_step(app: &mut App, kind: Grab, delta: i32, shift: bool) {
    let s = &app.overlays.share;
    let dur = track_secs(s);
    let w = window(s);
    let step = if shift { 5.0 } else { 1.0 } * delta.signum() as f64 * if delta.abs() >= 10 { 10.0 } else { 1.0 };
    let (start, duration) = match kind {
        Grab::Window => (s.start + step, w.end - s.start),
        Grab::Start => snippet::adjust(Grab::Start, s.start + step, s.start, w.end, dur, w.min_duration, w.max_duration, w.max_start),
        Grab::End => snippet::adjust(Grab::End, w.end + step, s.start, w.end, dur, w.min_duration, w.max_duration, w.max_start),
    };
    set_window(app, start, duration);
}

/// Home and End on the window and its edges.
pub(super) fn on_step_limit(app: &mut App, kind: Grab, to_end: bool) {
    let s = &app.overlays.share;
    let dur = track_secs(s);
    let w = window(s);
    let b = snippet::handle_bounds(dur, s.start, w.end, w.min_duration, w.max_duration);
    let (start, duration) = match kind {
        Grab::Window => (if to_end { w.max_start } else { 0.0 }, w.end - s.start),
        Grab::Start => {
            snippet::adjust(Grab::Start, if to_end { b.max_start } else { b.min_start }, s.start, w.end, dur, w.min_duration, w.max_duration, w.max_start)
        }
        Grab::End => {
            snippet::adjust(Grab::End, if to_end { b.max_end } else { b.min_end }, s.start, w.end, dur, w.min_duration, w.max_duration, w.max_start)
        }
    };
    set_window(app, start, duration);
}
