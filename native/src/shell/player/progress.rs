//! Playback progress without re-running the view: the seek bar's fill and
//! thumb and the times beside it are Rune live values, published from the
//! player's poll. The view only runs again for a real change (a track,
//! play/pause, a label growing a digit, a drag).
//!
//! The player samples the clock in 0.25 s steps. Rune's live bindings repaint
//! the full window when they change, so the native bar publishes at the
//! visible one-second clock cadence and snaps immediately for seeks, track
//! changes, and play/pause.

use rune::{El, Live, LiveText, Tx, el, text};

use crate::app::App;
use crate::format::fmt_duration_sec;
use crate::theme::Theme;
use crate::ui::{font, tnum};

/// The live values the seek bar and its times are bound to.
#[derive(Clone)]
pub struct Progress {
    /// The fill's rect in the track, `[x, y, w, h]`.
    fill: Live<[f32; 4]>,
    /// The thumb's offset along the track.
    thumb: Live<[f32; 2]>,
    pub elapsed: LiveText,
    /// The track's length ("4:12").
    pub total: LiveText,
    /// The mini player's countdown ("-3:57").
    pub remaining: LiveText,
    /// The seek bar's laid-out size.
    size: [f32; 2],
    /// The value the fill shows now.
    shown: f32,
    /// The last clock state sent to the live bar. Playback is sampled at the
    /// player cadence, but the window only needs a new composite once a whole
    /// displayed second has passed (or a real state/seek change occurred).
    last_track: Option<String>,
    last_position: Option<f64>,
    last_duration: Option<f64>,
    last_playing: Option<bool>,
}

impl Default for Progress {
    fn default() -> Self {
        Progress {
            fill: Live::new([0.0; 4]),
            thumb: Live::new([0.0; 2]),
            elapsed: LiveText::new("0:00"),
            total: LiveText::new("0:00"),
            remaining: LiveText::new("0:00"),
            size: [0.0; 2],
            shown: 0.0,
            last_track: None,
            last_position: None,
            last_duration: None,
            last_playing: None,
        }
    }
}

impl std::fmt::Debug for Progress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Progress").field("size", &self.size).finish()
    }
}

impl PartialEq for Progress {
    fn eq(&self, other: &Self) -> bool {
        self.size == other.size
    }
}

/// The clock as the bar shows it: position, length, and the share played.
fn clock(app: &App) -> (f64, f64, f32) {
    let p = &app.player;
    let duration = p.duration.unwrap_or(0.0);
    let v = if duration > 0.0 { (p.position / duration).clamp(0.0, 1.0) as f32 } else { 0.0 };
    (p.position, duration, v)
}

/// The three labels for the clock.
fn labels(position: f64, duration: f64) -> [String; 3] {
    let remaining = if duration > 0.0 { format!("-{}", fmt_duration_sec((duration - position).max(0.0))) } else { fmt_duration_sec(duration) };
    [fmt_duration_sec(position), fmt_duration_sec(duration), remaining]
}

impl Progress {
    fn rects(&self, v: f32) -> ([f32; 4], [f32; 2]) {
        let [w, h] = self.size;
        ([0.0, 0.0, v * w, h], [v * w, 0.0])
    }

    fn show(&mut self, v: f32) {
        self.shown = v;
        let (fill, thumb) = self.rects(v);
        self.fill.snap(fill);
        self.thumb.snap(thumb);
    }

    /// Land the fill and thumb at `v` at once (a release after a drag, a
    /// resize).
    pub fn snap(&mut self, v: f32) {
        self.show(v);
    }
}

/// Every frame, after the player's poll: publish the clock. True when the
/// view has to run again: a label changed its length (its box is sized from
/// the text the view last saw).
pub fn publish(app: &mut App, _now: f64, _tx: &mut Tx) -> bool {
    let (position, duration, v) = clock(app);
    let p = &mut app.ui.player.progress;
    let track = app.player.current().map(|t| t.id.clone());
    let state_changed = p.last_track != track
        || p.last_duration != app.player.duration
        || p.last_playing != Some(app.player.playing);
    let position_changed = p.last_position.is_none_or(|last| {
        !app.player.playing || position.floor() != last.floor() || (position - last).abs() >= 0.75
    });
    let clock_changed = state_changed || position_changed;
    if clock_changed && app.ui.seek_drag.as_ref().is_none_or(|(k, _)| k != "seek") {
        // Rune's live bindings composite the full window on every change. A
        // direct snap at the visible clock cadence keeps the bar accurate
        // while avoiding a second animation loop between player ticks.
        p.snap(v);
    }
    if clock_changed {
        p.last_track = track;
        p.last_position = Some(position);
        p.last_duration = app.player.duration;
        p.last_playing = Some(app.player.playing);
    }
    let mut relayout = false;
    for (live, s) in [&p.elapsed, &p.total, &p.remaining].into_iter().zip(labels(position, duration)) {
        if live.get().chars().count() != s.chars().count() {
            relayout = true;
        }
        live.set(s);
    }
    relayout
}

/// The seek bar was laid out at `w`×`h`.
pub fn resized(app: &mut App, w: f32, h: f32) {
    if app.ui.player.progress.size != [w, h] {
        app.ui.player.progress.size = [w, h];
        let (_, _, clock_value) = clock(app);
        let v = app.ui.seek_drag.as_ref().filter(|(k, _)| k == "seek").map_or(clock_value, |(_, v)| *v);
        app.ui.player.progress.snap(v);
    }
}

/// The played part of the seek bar, bound to the live clock.
pub fn fill(app: &App, t: &Theme) -> El {
    el().key("seek-fill").absolute(0.0, 0.0).size(0.0, 0.0).radius(999.0).fill(t.c.primary).inert().live_rect(&app.ui.player.progress.fill)
}

/// The seek bar's thumb (12 px, centred on the value), bound to the live
/// clock; grown 1.25× while dragged (`.bar.dragging .bar-thumb`). `h` is
/// the track's height.
pub fn thumb(app: &App, t: &Theme, h: f32, dragging: bool) -> El {
    el().key("seek-thumb").absolute(-6.0, (h - 12.0) / 2.0)
        .size(12.0, 12.0)
        .radius(999.0)
        .fill(t.c.background)
        .border(1.0, t.c.primary)
        .inert()
        .scale(if dragging { 1.25 } else { 1.0 })
        .group_opacity(if dragging { 1.0 } else { 0.0 }, 1.0)
        .live_offset(&app.ui.player.progress.thumb)
}

/// A tabular 12 px time bound to `live`: its box is the text the view saw,
/// which every later value of the same length fills exactly.
pub fn time_text(t: &Theme, live: &LiveText) -> (El, String) {
    let s = live.get().to_string();
    (text(s.clone()).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground).live_text(live), s)
}
