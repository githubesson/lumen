//! Playback progress without re-running the view: the seek bar's fill and
//! thumb and the times beside it are Rune live values, published from the
//! player's poll. The view only runs again for a real change (a track,
//! play/pause, a label growing a digit, a drag).
//!
//! The web moves the clock in 0.25 s steps and glides the fill over each
//! step (`transition: clip-path 250ms linear`); here the published steps are
//! smoothed by a 0.25 s spring.

use rune::{El, Live, LiveText, Spring, el, text};

use crate::app::App;
use crate::format::fmt_duration_sec;
use crate::theme::Theme;
use crate::ui::{font, tnum};

/// The clock's glide between its 0.25 s steps.
const GLIDE: Spring = Spring::new(0.25, 0.0);

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

    /// Land the fill and thumb at `v` at once (a release after a drag, a
    /// resize).
    pub fn snap(&self, v: f32) {
        let (fill, thumb) = self.rects(v);
        self.fill.snap(fill);
        self.thumb.snap(thumb);
    }
}

/// Every frame, after the player's poll: publish the clock. True when the
/// view has to run again: a label changed its length (its box is sized from
/// the text the view last saw).
pub fn publish(app: &mut App) -> bool {
    let (position, duration, v) = clock(app);
    let p = &app.ui.player.progress;
    if app.ui.seek_drag.as_ref().is_none_or(|(k, _)| k != "seek") {
        let (fill, thumb) = p.rects(v);
        p.fill.set(fill);
        p.thumb.set(thumb);
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
        let (_, _, v) = clock(app);
        app.ui.player.progress.snap(v);
    }
}

/// The played part of the seek bar, bound to the live clock.
pub fn fill(app: &App, t: &Theme) -> El {
    el().absolute(0.0, 0.0).size(0.0, 0.0).radius(999.0).fill(t.c.primary).inert().live_rect(app.ui.player.progress.fill.smooth(GLIDE))
}

/// The seek bar's thumb (12 px, centred on the value), bound to the live
/// clock. `h` is the track's height.
pub fn thumb(app: &App, t: &Theme, h: f32, dragging: bool) -> El {
    el().absolute(-6.0, (h - 12.0) / 2.0)
        .size(12.0, 12.0)
        .radius(999.0)
        .fill(t.c.background)
        .border(1.0, t.c.primary)
        .inert()
        .group_opacity(if dragging { 1.0 } else { 0.0 }, 1.0)
        .live_offset(app.ui.player.progress.thumb.smooth(GLIDE))
}

/// A tabular 12 px time bound to `live`: its box is the text the view saw,
/// which every later value of the same length fills exactly.
pub fn time_text(t: &Theme, live: &LiveText) -> (El, String) {
    let s = live.get().to_string();
    (text(s.clone()).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground).live_text(live), s)
}
