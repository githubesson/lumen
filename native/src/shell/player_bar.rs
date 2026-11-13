//! `MiniPlayer.tsx` in its docked form: `NowPlaying`, `Transport`,
//! `ProgressBar`, `VolumeControl` and the utility buttons (`player.css`),
//! with the popovers anchored above them and the remote-control notice.
//! In mini player mode the window is the bar (`shell::player::mini`), built
//! from the same pieces.

use rune::{Cursor, Cx, El, Icon, col, el, row, text};

use crate::app::App;
use crate::player::Repeat;
use crate::shell::Bp;
use crate::shell::player::{self as pui, adapters, devices, display, error, lyrics, queue};
use crate::theme::Theme;
use crate::ui::{self, css_border, font, ico, icons as i, line, tnum};
use crate::ui::tooltip::TipExt;

/// `.t-btn`: a 28 px muted icon button.
pub fn t_btn(t: &Theme, key: &str, glyph: &'static Icon, active: bool, disabled: bool) -> El {
    t_btn_icon(t, key, glyph, 14.0, active, disabled)
}

/// [`t_btn`] with an `icon` px glyph.
pub fn t_btn_icon(t: &Theme, key: &str, glyph: &'static Icon, icon: f32, active: bool, disabled: bool) -> El {
    let ink = if active { t.c.foreground } else { t.c.muted_foreground };
    t_btn_with(t, key, ico(glyph, icon, ink).group_color(t.c.foreground), active, disabled)
}

/// The utility row's icon size: 13 px in the mini player.
pub fn util_icon(app: &App) -> f32 {
    if app.ui.player.mini.on { 13.0 } else { 14.0 }
}

/// A disabled utility button: 40%, or 34% in the mini player.
pub fn util_disabled(app: &App, b: El, disabled: bool) -> El {
    if disabled && app.ui.player.mini.on { b.opacity(0.34) } else { b }
}

/// `.t-btn` around a glyph the caller drew (a coloured or pulsing one).
pub fn t_btn_with(t: &Theme, key: &str, glyph: El, active: bool, disabled: bool) -> El {
    let mut b = el().key(key).size(28.0, 28.0).radius(t.radius_md()).center().role("button").child(glyph);
    if active {
        b = b.fill(t.c.muted);
    }
    if disabled {
        b.opacity(0.4).disabled(true)
    } else {
        b.cursor(Cursor::Pointer).focusable(true).hover(t.c.ghost_hover)
    }
}

/// `SeekBar` (`.bar`, `.bar-fill`, `.bar-thumb`): an `h` px track (4, the
/// mini player's volume 3) with the played part in the primary colour, a
/// 24 px tall hit area that takes no layout space, and a 12 px thumb shown
/// on hover and while dragging (grown 1.25×). Seeks commit on release
/// unless `live` (the volume follows the pointer). Arrows step 5% from
/// `current`, Home and End go to the ends.
#[allow(clippy::too_many_arguments)]
pub fn seek_bar_h(app: &App, t: &Theme, key: &str, current: fn(&App) -> f32, label: &str, live: bool, h: f32, on_seek: fn(&mut App, f32)) -> El {
    bar_with(app, t, key, current, label, live, h, on_seek, false)
}

#[allow(clippy::too_many_arguments)]
fn bar_with(app: &App, t: &Theme, key: &str, current: fn(&App) -> f32, label: &str, live: bool, h: f32, on_seek: fn(&mut App, f32), clock: bool) -> El {
    let dragging = app.ui.seek_drag.as_ref().filter(|(k, _)| k == key).map(|(_, v)| *v);
    let v = dragging.unwrap_or_else(|| current(app)).clamp(0.0, 1.0);
    let k = key.to_string();
    let hit = el()
        .key(format!("{key}-hit"))
        .pin(Some(0.0), Some(-10.0), Some(0.0), Some(-10.0))
        .cursor(Cursor::Pointer)
        .on_drag(move |app: &mut App, d: &mut rune::Drag, _tx: &mut rune::Tx| {
            let at = if d.w > 0.0 { (d.x / d.w).clamp(0.0, 1.0) } else { 0.0 };
            match d.phase {
                rune::Phase::Down | rune::Phase::Move => {
                    app.ui.seek_drag = Some((k.clone(), at));
                    if live {
                        on_seek(app, at);
                    }
                }
                rune::Phase::Up => {
                    app.ui.seek_drag = None;
                    on_seek(app, at);
                    if clock {
                        // The fill stays where it was let go, rather than
                        // gliding back from where the clock last was.
                        app.ui.player.progress.snap(at);
                    }
                }
            }
        });
    let (fill, thumb_track) = if clock && dragging.is_none() {
        // Playback moves these through live values, not the view.
        (pui::progress::fill(app, t), pui::progress::thumb(app, t, h, false))
    } else {
        let thumb_opacity = if dragging.is_some() { 1.0 } else { 0.0 };
        // Centred on the value: the end of a box `v` of the track wide, pulled 6 px past it.
        let thumb = el()
            .key(format!("{key}-thumb"))
            .size(12.0, 12.0)
            .mr(-6.0)
            .radius(999.0)
            .fill(t.c.background)
            .border(1.0, t.c.primary)
            .scale(if dragging.is_some() { 1.25 } else { 1.0 })
            .group_opacity(thumb_opacity, 1.0);
        let thumb_track = el().pin(Some(0.0), Some(0.0), None, Some(0.0)).w_frac(v).items_center().justify_end().inert().child(thumb);
        let mut fill = el().pin(Some(0.0), Some(0.0), None, Some(0.0)).w_frac(v).radius(999.0).fill(t.c.primary).inert();
        if dragging.is_none() {
            // A 250 ms glide, as `transition: clip-path 250ms linear`.
            fill = fill.motion(rune_motion::Spring::new(0.25, 0.0));
        } else {
            fill = fill.instant_changes();
        }
        // At 0 the CSS clip hides the fill entirely; a zero-width pill would
        // still leave an anti-aliased sliver.
        (if v > 0.0 { fill } else { fill.opacity(0.0) }, thumb_track)
    };
    let mut bar = el()
        .key(key)
        .grow(1.0)
        .h(h)
        .radius(999.0)
        .fill(t.c.muted)
        .hover_group()
        .role("slider")
        .label(label)
        .range_value((v * 100.0).round() as f64, 0.0, 100.0)
        .on_step(move |app: &mut App, delta: i32, _tx: &mut rune::Tx| on_seek(app, (current(app) + 0.05 * delta as f32).clamp(0.0, 1.0)))
        .on_step_limit(move |app: &mut App, max: bool, _tx: &mut rune::Tx| on_seek(app, if max { 1.0 } else { 0.0 }))
        .child(fill)
        .child(thumb_track)
        .child(hit);
    if clock {
        bar = bar.on_layout(|app: &mut App, r: [f32; 4]| pui::progress::resized(app, r[2], r[3]));
    }
    bar
}

/// The now-playing cover (`.np-art`): the track's, or the muted placeholder.
pub fn np_art(app: &App, t: &Theme, size: f32, radius: f32) -> El {
    let track = app.player.current();
    let cover = track.map(|tr| tr.cover_at(None));
    let letter = track
        .map(|tr| crate::format::display_text(tr.album_title.as_deref().filter(|s| !s.is_empty()).or(Some(&tr.title)), "·"))
        .unwrap_or_else(|| "·".into());
    ui::cover_art(t, &app.images, cover.as_deref(), &letter, size, size, radius).key("np-art")
}

/// The artist line, or the failure in its place (`.np-artist`, `.np-error`).
/// `underline_at` is where the error's underline sits in the line's box.
pub fn np_artist(app: &App, t: &Theme, style: rune::TextStyle, underline_at: f32) -> El {
    let d = display::display(app);
    if let Some(summary) = &d.error {
        return error::line_button(app, t, summary, style, underline_at);
    }
    let shown = match linked(app, &d) {
        Some(track) => ui::entity_links::line(track, ui::entity_links::np_artist_links(track), style, t.c.muted_foreground),
        None => line(d.artist.clone(), style, t.c.muted_foreground),
    };
    shown.tip_truncated("np-artist", &d.artist, style)
}

/// The track whose title, artists and album open their pages: the bar's
/// (not the mini player's), and not while a failure shows in their place.
fn linked<'a>(app: &App, d: &display::Display<'a>) -> Option<&'a crate::api::TrackListItem> {
    d.current.filter(|_| !app.ui.player.mini.on && d.error.is_none())
}

/// Right-click on the now-playing block opens the track's menu (not while
/// another device plays: its track isn't ours to act on).
pub fn np_context(app: &App, e: El) -> El {
    let d = display::display(app);
    match d.current {
        Some(track) if !d.remote => {
            let track = track.clone();
            e.on_secondary_press(move |app: &mut App, at, _tx: &mut rune::Tx| {
                adapters::open_track_menu(app, &track, at, adapters::MenuContext::default())
            })
        }
        _ => e,
    }
}

fn now_playing(app: &App, t: &Theme, bp: Bp) -> El {
    let art_size = if bp == Bp::Narrow { 44.0 } else { 48.0 };
    let d = display::display(app);
    let title_style = font(14.0, 500.0);
    let title = match linked(app, &d) {
        Some(track) => ui::entity_links::line(track, ui::entity_links::album_title_link(&d.title), title_style, t.c.foreground),
        None => line(d.title.clone(), title_style, t.c.foreground),
    };
    // 6 px apart, not 2: the title and the artist line are both links, each
    // a 24 px target clear of the other (WCAG 2.5.8). It stays while a
    // failure replaces the links, so the lines don't jump.
    let lines = col()
        .grow(1.0)
        .min_w(0.0)
        .h(art_size)
        .gap(6.0)
        .justify_center()
        .child(title.tip_truncated("np-title", &d.title, title_style).h(20.3))
        .child(el().h(17.4).min_w(0.0).child(np_artist(app, t, font(12.0, 400.0), error::underline_at(12.0, 17.4))));
    let np = row()
        .key("np")
        .gap(if bp == Bp::Wide { 12.0 } else { 10.0 })
        .items_center()
        .min_w(0.0)
        .child(np_art(app, t, art_size, t.radius_md()))
        .child(lines);
    np_context(app, np)
}

/// Sizes of the transport row: the bar's, or the mini player's larger one.
#[derive(Clone, Copy)]
pub struct TransportSize {
    pub btn: f32,
    pub gap: f32,
    pub play: f32,
    pub play_icon: f32,
    pub play_margin: f32,
    /// ≤ 430 px mini windows drop shuffle and repeat.
    pub compact: bool,
}

pub const BAR_TRANSPORT: TransportSize = TransportSize { btn: 28.0, gap: 8.0, play: 32.0, play_icon: 16.0, play_margin: 0.0, compact: false };

/// `.transport-row`: shuffle, previous, play/pause, next, repeat.
pub fn transport_row(app: &App, t: &Theme, s: TransportSize) -> El {
    let p = &app.player;
    let d = display::display(app);
    let disabled = d.transport_disabled;
    let sized = |b: El| b.size(s.btn, s.btn);
    let repeat_active = p.repeat != Repeat::Off;
    let mut repeat = sized(t_btn(t, "repeat", &i::REPEAT, repeat_active, d.command_pending))
        .label(p.repeat.label())
        .on_press(|app: &mut App| app.player.cycle_repeat());
    if p.repeat == Repeat::One {
        let c = s.btn / 2.0;
        repeat = repeat.child(text("1").font(font(12.0, 600.0)).color(t.c.foreground).absolute(c + 8.0 - 3.5, c + 8.0 - 8.7));
    }
    let play = el()
        .key("play")
        .size(s.play, s.play)
        .mx(s.play_margin)
        .radius(999.0)
        .fill(t.c.primary)
        .center()
        .role("button")
        .label(if p.playing { "Pause" } else { "Play" })
        .child(ico(if p.playing { &i::PAUSE_FILLED } else { &i::PLAY_FILLED }, s.play_icon, t.c.primary_foreground));
    let play = if disabled {
        play.opacity(0.5).disabled(true)
    } else {
        // The primary at 80% over the bar is the bar's colour at 20% over the primary.
        play.cursor(Cursor::Pointer).focusable(true).hover(t.c.background.alpha(0.2)).on_press(|app: &mut App| app.player.toggle_play())
    };
    let mut controls = row().key("transport-row").gap(s.gap).items_center();
    if !s.compact {
        controls = controls.child(
            sized(t_btn(t, "shuffle", &i::SHUFFLE, p.shuffle, d.command_pending)).label("Shuffle").on_press(|app: &mut App| app.player.toggle_shuffle()),
        );
    }
    controls = controls
        .child(sized(t_btn(t, "previous", &i::SKIP_BACK_FILLED, false, disabled)).label("Previous").on_press(|app: &mut App| app.player.previous()))
        .child(play)
        .child(sized(t_btn(t, "next", &i::SKIP_FORWARD_FILLED, false, disabled)).label("Next").on_press(|app: &mut App| app.player.next()));
    if !s.compact {
        controls = controls.child(repeat);
    }
    controls
}

/// The seek position, 0–1.
pub fn progress_value(app: &App) -> f32 {
    let p = &app.player;
    let duration = p.duration.unwrap_or(0.0);
    if duration > 0.0 { (p.position / duration) as f32 } else { 0.0 }
}

/// `.progress-time`: a tabular 12 px time, at least `min_w` wide, bound to a
/// live clock label.
pub fn live_time_label(t: &Theme, key: &str, live: &rune::LiveText, min_w: f32, align: rune::Align) -> El {
    let (label, s) = pui::progress::time_text(t, live);
    time_box(key, label, &s, min_w, align)
}

fn time_box(key: &str, label: El, s: &str, min_w: f32, align: rune::Align) -> El {
    let style = tnum(font(12.0, 400.0));
    let e = el().key(key).min_w(min_w).h(17.4).items_start();
    let s = s.to_string();
    match align {
        rune::Align::Start => e.child(label),
        rune::Align::End => e.justify_end().child(ui::nudge_end(label, &s, style)),
        _ => e.justify_center().child(ui::nudge_centre(label, &s, style)),
    }
}

/// The seek bar.
pub fn seek(app: &App, t: &Theme) -> El {
    let on_seek = |app: &mut App, v: f32| {
        let d = app.player.duration.unwrap_or(0.0);
        app.player.seek(v as f64 * d);
    };
    bar_with(app, t, "seek", progress_value, "Seek", false, 4.0, on_seek, true)
}

fn transport(app: &App, t: &Theme, bp: Bp) -> El {
    let controls = transport_row(app, t, BAR_TRANSPORT);
    if bp == Bp::Narrow {
        // `.progress` hides on narrow windows.
        return col().key("transport").min_w(0.0).items_center().child(controls);
    }
    let progress_row = row()
        .key("progress")
        .w_full()
        .gap(if bp == Bp::Medium { 6.0 } else { 8.0 })
        .items_center()
        .child(live_time_label(t, "elapsed", &app.ui.player.progress.elapsed, 32.0, rune::Align::Center))
        .child(seek(app, t))
        .child(live_time_label(t, "remaining", &app.ui.player.progress.total, 32.0, rune::Align::Center));
    col().key("transport").w_full().min_w(0.0).gap(6.0).items_center().child(controls).child(progress_row)
}

/// `FavoriteButton` as the bar's `.t-btn`: the heart fills while the track
/// is a favourite and pops (1.25× and back over 240 ms) as it turns on.
pub fn favorite_button(app: &App, t: &Theme, icon_size: f32, btn: f32) -> El {
    let d = display::display(app);
    let fav = d.current.is_some_and(|tr| adapters::is_favorite(app, &tr.id));
    let ink = if fav { t.c.foreground } else { t.c.muted_foreground };
    let pops = app.ui.player.fav_pops;
    let mut heart = ico(if fav { &i::HEART_FILLED } else { &i::HEART }, icon_size, ink)
        .group_color(t.c.foreground)
        .key(format!("favorite-heart-{pops}"))
        .transition(rune::Transition::none());
    if pops > 0 && fav {
        heart = heart.looping(rune::LoopSpec::sequence(rune::Sequence::new(&ui::track_row::HEART_POP)));
    }
    let disabled = d.current.is_none() || d.remote;
    let mut b = util_disabled(app, t_btn_with(t, "favorite", heart, fav, disabled), disabled)
        .size(btn, btn)
        .label(if fav { "Remove from favorites" } else { "Add to favorites" })
        .checked(fav);
    if let Some(id) = d.current.map(|tr| tr.id.clone()) {
        b = b.on_press(move |app: &mut App| adapters::toggle_favorite(app, &id));
    }
    b
}

/// The lyrics button: the column's toggle, or the mini player's lyrics panel's.
pub fn lyrics_button(app: &App, t: &Theme) -> El {
    let mini = app.ui.player.mini.on;
    let open = if mini { app.ui.player.mini.requested == Some(pui::mini::Panel::Lyrics) } else { app.ui.lyrics_open };
    // The lit tab is the mini panel's close control, so it stays usable if
    // the track goes away while lyrics are showing.
    let disabled = app.player.current().is_none() && !(mini && open);
    let b = t_btn_icon(t, "lyrics", &i::MIC_VOCAL, util_icon(app), open, disabled).label("Toggle lyrics panel").tip("lyrics", "Lyrics").checked(open);
    let b = util_disabled(app, b, disabled);
    if mini {
        b.on_press_tx(|app: &mut App, tx: &mut rune::Tx| pui::mini::toggle_panel(app, tx, pui::mini::Panel::Lyrics))
    } else {
        b.on_press(|app: &mut App| {
            let open = !app.ui.lyrics_open;
            lyrics::set_open(app, open)
        })
    }
}

/// `VolumeControl` (`.volume`): mute and the volume bar, `w` wide.
pub fn volume(app: &App, t: &Theme, w: f32, gap: f32, btn: f32, icon: f32, bar_h: f32) -> El {
    let p = &app.player;
    let off = p.muted || p.volume == 0.0;
    let ink = t.c.muted_foreground;
    let mute = t_btn_with(t, "mute", ico(if off { &i::VOLUME_X } else { &i::VOLUME_2 }, icon, ink).group_color(t.c.foreground), false, false)
        .size(btn, btn)
        .label(if off { "Unmute" } else { "Mute" })
        .on_press(|app: &mut App| app.player.toggle_mute());
    row()
        .key("volume")
        .w(w)
        .gap(gap)
        .items_center()
        .child(mute)
        .child(seek_bar_h(app, t, "volume-bar", |app: &App| if app.player.muted { 0.0 } else { app.player.volume }, "Volume", true, bar_h, |app: &mut App, v: f32| {
            app.player.set_volume(v)
        }))
}

/// The mini player toggle (`.mini-mode-toggle`).
pub fn mini_toggle(app: &App, t: &Theme) -> El {
    let on = app.ui.player.mini.on;
    let label = if on { "Exit mini player" } else { "Mini player" };
    let b = if on {
        // In the mini player: an outlined 28 px button in the foreground. It
        // is `.t-btn.active` too, whose `--muted` outranks `--input-bg`;
        // its own hover rule comes last.
        css_border(el(), 1.0, t.c.input, t.radius_md())
            .key("mini-player")
            .size(28.0, 28.0)
            .ml(4.0)
            .radius(t.radius_md())
            .fill(t.c.muted)
            .center()
            .role("button")
            .cursor(Cursor::Pointer)
            .focusable(true)
            .hover(ui::hover_overlay(t.c.muted, t.c.input_bg_hover))
            .child(ico(&i::MAXIMIZE_2, 13.0, t.c.foreground))
    } else {
        t_btn(t, "mini-player", &i::MINIMIZE_2, false, false)
    };
    b.label(label).tip("mini-player", label).checked(on).on_press_tx(|app: &mut App, tx: &mut rune::Tx| pui::mini::toggle_mode(app, tx))
}

fn utility(app: &App, t: &Theme, bp: Bp) -> El {
    let mut u = row()
        .key("utility")
        .gap(8.0)
        .items_center()
        .justify_end()
        .child(devices::button(app, t))
        .child(favorite_button(app, t, util_icon(app), 28.0))
        .child(lyrics_button(app, t))
        .child(queue::button(app, t));
    u = if bp == Bp::Narrow {
        u.child(el().w(0.0).ml(-8.0))
    } else {
        u.child(volume(app, t, if bp == Bp::Medium { 104.0 } else { 130.0 }, if bp == Bp::Medium { 6.0 } else { 8.0 }, 28.0, 14.0, 4.0))
    };
    u.child(mini_toggle(app, t))
}

/// The bar (`.player-bar`) at the window's width range.
fn bar(app: &App, t: &Theme, bp: Bp) -> El {
    // `grid-template-columns`: `1fr 1.3fr 1fr` (gap 16), `minmax(0, .9fr)
    // minmax(260px, 1.2fr) auto` (gap 10) at 761–1100 px, and
    // `minmax(0, 1fr) auto auto` (gap 8) at 760 px and under.
    let (h, pad, gap) = match bp {
        Bp::Wide => (72.0, 12.0, 16.0),
        Bp::Medium => (68.0, 10.0, 10.0),
        Bp::Narrow => (64.0, 10.0, 8.0),
    };
    let bar = css_border(row(), 1.0, t.c.border, t.radius_xl())
        .key("player-bar")
        .w_full()
        .h(h)
        .px(pad + 1.0)
        .py(1.0)
        .gap(gap)
        .items_center()
        .radius(t.radius_xl())
        .fill(t.c.background)
        .label("Player");
    match bp {
        Bp::Wide => bar
            .child(el().grow(1.0).w(0.0).min_w(0.0).child(now_playing(app, t, bp).w_full()))
            .child(el().grow(1.3).w(0.0).min_w(0.0).child(transport(app, t, bp)))
            .child(el().grow(1.0).w(0.0).min_w(0.0).justify_end().child(utility(app, t, bp))),
        Bp::Medium => bar
            .child(el().grow(0.9).w(0.0).min_w(0.0).child(now_playing(app, t, bp).w_full()))
            .child(el().grow(1.2).w(0.0).min_w(260.0).child(transport(app, t, bp)))
            .child(utility(app, t, bp)),
        Bp::Narrow => bar
            .child(el().grow(1.0).w(0.0).min_w(0.0).child(now_playing(app, t, bp).w_full()))
            .child(transport(app, t, bp))
            .child(utility(app, t, bp)),
    }
}

/// `.player-shell`: the bar, the remote-control notice over its top edge,
/// and the popovers anchored to its buttons. In mini player mode, the whole
/// window.
pub fn view(app: &App, t: &Theme, bp: Bp, cx: &mut Cx<App>) -> El {
    if app.ui.player.mini.on {
        return pui::mini::view(app, t, cx);
    }
    let mut shell = col()
        .key("player-shell")
        .w_full()
        .min_w(0.0)
        .on_layout(|app: &mut App, r: [f32; 4]| {
            // The shell's padding is the same on every side: the window is
            // the shell's far corner plus its left offset.
            if !app.ui.player.mini.on {
                let size = (r[0] * 2.0 + r[2], r[1] + r[3] + r[0]);
                if app.ui.player.window != Some(size) {
                    app.ui.player.window = Some(size);
                }
            }
        })
        .child(bar(app, t, bp));
    if let Some(notice) = devices::remote_indicator(app, t, false) {
        shell = shell.child(notice);
    }
    for pop in [queue::popover(app, t, cx), devices::popover(app, t), error::popover(app, t, cx)].into_iter().flatten() {
        shell = shell.child(pop);
    }
    shell
}
