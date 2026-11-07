//! `ShareDialog.tsx`, `context/Share.tsx` and `components/share/*`
//! (`PreviewStrip`, `CopyLinkButton`, `useShareLink`, `useSnippetPreview`):
//! pick a window of a track and copy a link that unfurls into a chat video
//! embed (cover + audio snippet), or save that video. Copy stays disabled
//! until the window has been moved or trimmed once, so the default is never
//! shared by accident.
mod strip;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use rune::{Color, Cx, El, Tx, col, el, row, text};

use crate::api::share::{DEFAULT_SHARE_SNIPPET_DURATION_SEC, create_track_share_link, parse_track_share_url, track_share_preview_video_path};
use crate::api::{ApiError, TrackDetail};
use crate::app::App;
use crate::core::share_link_session::{Ensure, ShareLinkSession};
use crate::core::share_snippet::{
    SnippetGrab as Grab, SnippetSelection, SnippetState, SnippetWindow, adjust_snippet_window, normalize_snippet_selection,
    share_clip_name, snippet_drag_target, snippet_handle_bounds, snippet_window,
};
use crate::core::track::primary_artist_name;
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
    /// The window's link (`useShareLinkSession`), minted on first use.
    link: ShareLinkSession<Action>,
    pub busy: bool,
    pub copied: crate::ui::flash::Flag,
    pub copy_error: Option<String>,
    pub downloading: bool,
    pub download_error: Option<String>,
    pub playing: bool,
    pub current: f64,
    /// What a press on the strip grabbed, and where on it.
    drag: Option<(Grab, f64)>,
    /// Bumped as the dialog opens or closes, so late answers drop.
    gen_: Arc<AtomicU64>,
    /// The dialog's own `<audio>` on the track's stream; made on the first
    /// play (none in headless runs).
    audio: Option<Box<dyn crate::player::adapter::AudioAdapter>>,
}

/// What waits for the window's link.
enum Action {
    Copy,
    /// Save the preview video, offering this file name.
    Download(String),
}

/// Open the dialog for a track id (`useShare().open(trackId)`).
pub fn open(app: &mut App, track_id: &str) {
    let gen_ = app.overlays.share.gen_.clone();
    gen_.fetch_add(1, Ordering::Relaxed);
    app.overlays.share = State {
        track_id: Some(track_id.to_string()),
        selected: DEFAULT_SHARE_SNIPPET_DURATION_SEC as f64,
        gen_,
        ..Default::default()
    };
    load(app, track_id.to_string());
}

pub fn close(app: &mut App) {
    let s = &mut app.overlays.share;
    s.gen_.fetch_add(1, Ordering::Relaxed);
    s.track_id = None;
    s.playing = false;
    // Unmounting the dialog stops its audio.
    s.audio = None;
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
        move || crate::api::library::get_track(&client, &id),
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
fn set_window(app: &mut App, sel: SnippetSelection) {
    let s = &mut app.overlays.share;
    let sel = normalize_snippet_selection(track_secs(s), sel.start_sec, sel.duration_sec);
    if s.picked && s.start == sel.start_sec && s.selected == sel.duration_sec {
        return;
    }
    s.start = sel.start_sec;
    s.selected = sel.duration_sec;
    s.picked = true;
    s.link.invalidate();
    s.copied.clear();
}

fn window(s: &State) -> SnippetWindow {
    snippet_window(track_secs(s), s.selected, s.start)
}

/// The selection and its limits, as the trim gestures take them.
fn bounds(s: &State) -> SnippetState {
    let w = window(s);
    SnippetState {
        start_sec: s.start,
        end_sec: w.end_sec,
        duration_sec: track_secs(s),
        min_duration_sec: w.min_duration_sec,
        max_duration_sec: w.max_duration_sec,
        max_start_sec: w.max_start_sec,
    }
}

/// `ensureUrl`: the link for this window, minted once; `action` runs with
/// it (or with why there is none).
fn ensure_url(app: &mut App, action: Action) {
    let Some(client) = app.client.clone() else { return };
    let s = &mut app.overlays.share;
    let Some(id) = s.track_id.clone() else { return };
    let (start, dur) = (s.start, window(s).effective_duration_sec);
    let gen_ = s.gen_.clone();
    match s.link.ensure(&id, start as u64, dur as u32, action) {
        Ensure::Ready(url, action) => run(app, action, Ok(url)),
        Ensure::Waiting => {}
        Ensure::Mint(ticket) => {
            let at = gen_.load(Ordering::Relaxed);
            app.net.run(
                move || create_track_share_link(&client, &id, start, dur).map(|l| l.url),
                move |app, result| {
                    // The dialog closed: its session went with it.
                    if gen_.load(Ordering::Relaxed) != at {
                        return;
                    }
                    let done = app.overlays.share.link.finish(ticket, result);
                    for action in done.actions {
                        run(app, action, done.url.clone());
                    }
                },
            );
        }
    }
}

/// An action that waited for the window's link.
fn run(app: &mut App, action: Action, url: Result<String, ApiError>) {
    match action {
        Action::Copy => {
            let s = &mut app.overlays.share;
            s.busy = false;
            match url {
                Ok(url) => super::later(app, move |app, tx| {
                    tx.copy(url);
                    flash_copied(app);
                }),
                Err(e) => {
                    s.copy_error = Some(super::error_message(&e, "Couldn't copy link — try again or copy the URL manually."))
                }
            }
        }
        Action::Download(file_name) => {
            let reference = url.map_err(|e| super::error_message(&e, "Couldn't download the video — try again.")).and_then(|u| {
                parse_track_share_url(&u).ok_or_else(|| "Couldn't read the generated share link.".to_string())
            });
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
                        Ok(Some(path)) => save_video(app, track_share_preview_video_path(&r), path),
                        _ => app.overlays.share.downloading = false,
                    });
                }),
            }
        }
    }
}

fn copy(app: &mut App) {
    let s = &mut app.overlays.share;
    if s.track_id.is_none() || !s.picked || s.busy || app.client.is_none() {
        return;
    }
    s.download_error = None;
    s.copy_error = None;
    s.busy = true;
    ensure_url(app, Action::Copy);
}

/// `useCopiedFlag(1800)`.
fn flash_copied(app: &mut App) {
    crate::ui::flash::flash(app, |app| &mut app.overlays.share.copied, 1800);
}

/// Save the window's preview video (the MP4 that unfurls in chat).
fn download_video(app: &mut App) {
    let s = &mut app.overlays.share;
    let Some(track) = &s.track else { return };
    if !s.picked || s.busy || s.downloading || app.client.is_none() {
        return;
    }
    let file_name = format!("{}.mp4", share_clip_name(Some(&track.title), None, &track.artists));
    s.downloading = true;
    s.download_error = None;
    s.copy_error = None;
    ensure_url(app, Action::Download(file_name));
}

fn save_video(app: &mut App, url: String, path: std::path::PathBuf) {
    let Some(client) = app.client.clone() else {
        app.overlays.share.downloading = false;
        return;
    };
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

/// Play the window end to end, as the embed will (`useSnippetPreview`):
/// the track's stream in the dialog's own audio, from `start`.
fn toggle_play(app: &mut App) {
    let s = &mut app.overlays.share;
    if s.playing {
        s.playing = false;
        if let Some(a) = s.audio.as_mut() {
            a.pause();
        }
        return;
    }
    s.playing = true;
    s.current = s.start;
    if rune::tooling::headless_run().is_some() || app.net.is_sync() {
        return;
    }
    let Some(id) = s.track_id.clone() else { return };
    let Some(client) = app.client.clone() else { return };
    if s.audio.is_none() {
        let engine = crate::player::engine::Engine::start(app.waker.clone(), app.config.audio_sink_id.clone());
        let shared = Arc::new(std::sync::Mutex::new(Some(client.clone())));
        let mut audio: Box<dyn crate::player::adapter::AudioAdapter> = Box::new(crate::player::engine::EngineAdapter::new(engine, shared));
        audio.load(&client.url(&crate::api::media::stream_path(&id)));
        s.audio = Some(audio);
    }
    let start = s.start;
    if let Some(a) = s.audio.as_mut() {
        a.seek(start);
        if !a.play() {
            s.playing = false;
        }
    }
}

/// Before each frame while the preview plays: follow the audio's clock
/// (`timeupdate`), and back to the window's start at its end.
pub fn poll(app: &mut App, tx: &mut rune::Tx) -> bool {
    let s = &mut app.overlays.share;
    let end = window(s).end_sec;
    let Some(audio) = s.audio.as_mut() else { return false };
    let mut ended = false;
    while let Some(ev) = audio.next_event() {
        ended |= matches!(ev, crate::player::adapter::AdapterEvent::Ended | crate::player::adapter::AdapterEvent::Error);
    }
    if !s.playing {
        return ended;
    }
    let now = audio.current_time();
    if ended || now >= end {
        audio.pause();
        s.playing = false;
        s.current = s.start;
    } else {
        // The window moved under the playhead: snap back to its start.
        if now < s.start - 0.5 {
            audio.seek(s.start);
        }
        s.current = now.max(s.start);
        tx.wake_after(std::time::Duration::from_millis(250));
    }
    true
}

fn header(app: &App, t: &Theme, track: &TrackDetail) -> El {
    let cover = track.has_cover.then(|| crate::api::media::track_cover(&track.id, track.album_id.as_deref(), track.cover_url.as_deref(), None));
    let mut sub = primary_artist_name(&track.artists, "Unknown artist");
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
    let shown = if s.busy { 1 } else if s.copied.on() { 2 } else { 0 };
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
                        .child(text(fmt_duration_sec(w.display_duration_sec)).font(tnum(font(14.0, 400.0))).color(t.c.popover_foreground).h(20.3)),
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
                                fmt_duration_sec(w.end_sec),
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
        if let Some(url) = s.link.share_url() {
            b = b.child(
                css_border(col(), 1.0, t.c.border, t.radius_lg())
                    .w_full()
                    .padding(11.0)
                    .gap(6.0)
                    .radius(t.radius_lg())
                    .fill(t.c.muted)
                    .child(eyebrow(t, "Share link"))
                    .child(text(url.to_string()).font(with_lh(mono(12.0, 400.0), 17.4)).color(t.c.foreground).wrap_anywhere()),
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
    let b = bounds(s);
    match d.phase {
        rune::Phase::Down => {
            // A press outside the window (`recenter`) moves it there at once,
            // as every press runs the gesture below.
            let target = snippet_drag_target(at, b.start_sec, b.end_sec, dur, d.w as f64);
            s.drag = Some((target.kind, target.grab_offset_sec));
        }
        rune::Phase::Up => {
            s.drag = None;
            return;
        }
        rune::Phase::Move => {}
    }
    let Some((kind, offset)) = s.drag else { return };
    set_window(app, adjust_snippet_window(kind, at - offset, &b));
}

/// Arrow keys on the window (move it) and on its edges (trim).
pub(super) fn on_step(app: &mut App, kind: Grab, delta: i32, shift: bool) {
    let b = bounds(&app.overlays.share);
    let step = if shift { 5.0 } else { 1.0 } * delta.signum() as f64 * if delta.abs() >= 10 { 10.0 } else { 1.0 };
    let sel = match kind {
        Grab::Window => SnippetSelection { start_sec: b.start_sec + step, duration_sec: b.end_sec - b.start_sec },
        Grab::Start => adjust_snippet_window(kind, b.start_sec + step, &b),
        Grab::End => adjust_snippet_window(kind, b.end_sec + step, &b),
    };
    set_window(app, sel);
}

/// Home and End on the window and its edges.
pub(super) fn on_step_limit(app: &mut App, kind: Grab, to_end: bool) {
    let b = bounds(&app.overlays.share);
    let h = snippet_handle_bounds(b.duration_sec, b.start_sec, b.end_sec, b.min_duration_sec, b.max_duration_sec);
    let sel = match kind {
        Grab::Window => SnippetSelection {
            start_sec: if to_end { b.max_start_sec } else { 0.0 },
            duration_sec: b.end_sec - b.start_sec,
        },
        Grab::Start => adjust_snippet_window(kind, if to_end { h.max_start_sec } else { h.min_start_sec }, &b),
        Grab::End => adjust_snippet_window(kind, if to_end { h.max_end_sec } else { h.min_end_sec }, &b),
    };
    set_window(app, sel);
}
