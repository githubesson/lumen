//! Mini player mode: `player/useMiniPlayerMode.ts`, `MiniPlayer.tsx`'s
//! window form, `player/MiniPlayerPanel.tsx` and every
//! `html[data-mini-player]` rule (`player.css`, `mini-player-panel.css`,
//! `responsive.css`, `lyrics-sidebar.css`, `electron.css`).
//!
//! The whole window becomes the bar (780×184). A panel (the playback error,
//! devices, lyrics or the queue) grows the window to 344 px, then the bar
//! morphs into two columns: the cover, track, progress and transport stack
//! on the left, the panel opens on the right. Closing runs the morph back
//! and shrinks the window after. Here the morph is the pieces' shared-element
//! flight (`El::matched`) between the two layouts.

use std::time::{Duration, Instant};

use rune::{Align, Cx, El, Tx, col, el, row, text};

use super::{display, position_pill, status_pill, window_bridge};
use crate::app::App;
use crate::ui::tooltip::TipExt;
use crate::shell::player_bar::{self as bar, TransportSize};
use crate::theme::Theme;
use crate::ui::{css_border, font, with_lh};

/// What the panel can show, in the order their controls sit in the bar.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Panel {
    Error,
    Devices,
    Lyrics,
    Queue,
}

impl Panel {
    fn name(self) -> &'static str {
        match self {
            Panel::Error => "error",
            Panel::Devices => "devices",
            Panel::Lyrics => "lyrics",
            Panel::Queue => "queue",
        }
    }
    fn title(self) -> &'static str {
        match self {
            Panel::Error => "Playback error",
            Panel::Devices => "Play on",
            Panel::Lyrics => "Lyrics",
            Panel::Queue => "Queue",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Panel::Error => "Playback error",
            Panel::Devices => "Playback device",
            Panel::Lyrics => "Lyrics",
            Panel::Queue => "Play queue",
        }
    }
}

/// The edge of the window that stays put while it grows for a panel.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Anchor {
    #[default]
    Top,
    Bottom,
}

/// Which side a panel swapped in for another slides in from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Swap {
    Forward,
    Back,
}

/// `useMiniPlayerMode`'s state.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mini {
    pub on: bool,
    /// What the layout shows.
    pub panel: Option<Panel>,
    /// What the user last asked for (its button is lit).
    pub requested: Option<Panel>,
    pub enter: Option<Swap>,
    pub anchor: Anchor,
    /// The bar's own height, kept while the window around it is taller.
    pub bar_height: Option<f32>,
    /// When the window shrinks back, after the closing morph.
    shrink_at: Option<Instant>,
}

/// The closing morph (`--mini-morph-dur` for "close").
const CLOSE_MORPH: Duration = Duration::from_millis(300);

/// Enter or leave mini player mode. Leaving restores the normal window
/// whatever the panel was doing; entering closes the lyrics column.
pub fn toggle_mode(app: &mut App, tx: &mut Tx) {
    let next = !app.ui.player.mini.on;
    let m = &mut app.ui.player.mini;
    if !next {
        *m = Mini::default();
    }
    m.on = next;
    // Popovers close whenever their buttons switch to panels and back.
    app.ui.player.popover = None;
    if next && app.ui.lyrics_open {
        app.ui.lyrics_open = false;
    }
    if !window_bridge::set_mini_player(app, tx, next) {
        app.ui.player.mini.on = !next;
    }
    super::lyrics::sync(app);
}

/// Toggle `which`'s panel.
pub fn toggle_panel(app: &mut App, tx: &mut Tx, which: Panel) {
    let next = if app.ui.player.mini.requested == Some(which) { None } else { Some(which) };
    request_panel(app, tx, next, false);
}

/// What the window has to do for a panel request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Nothing,
    /// Grow the window for the panel (the bar pinned to its edge first).
    Grow,
    /// Shrink it back at once (Escape).
    ShrinkNow,
    /// Shrink it back once the closing morph is done.
    ShrinkAfterMorph,
}

impl Mini {
    /// Ask for `next` (None closes the panel): what the layout shows now,
    /// and what the window has to do. A panel swapped for another slides in
    /// from its button's side; one opened while the window is still grown
    /// from the last (its shrink pending) just shows again.
    pub fn request(&mut self, next: Option<Panel>, instant: bool) -> Step {
        self.requested = next;
        match (self.panel, next) {
            (Some(from), Some(to)) if from != to => {
                self.enter = Some(if to > from { Swap::Forward } else { Swap::Back });
                self.panel = Some(to);
                Step::Nothing
            }
            (None, Some(to)) => {
                self.enter = None;
                self.panel = Some(to);
                if self.shrink_at.take().is_some() {
                    return Step::Nothing;
                }
                // Pin the bar to the edge that stays put before the window grows.
                self.bar_height = Some(self.bar_height.unwrap_or(window_bridge::MINI_SIZE.1));
                Step::Grow
            }
            (Some(_), None) => {
                self.panel = None;
                self.enter = None;
                if instant {
                    self.shrink_at = None;
                    Step::ShrinkNow
                } else {
                    self.shrink_at = Some(Instant::now() + CLOSE_MORPH);
                    Step::ShrinkAfterMorph
                }
            }
            _ => Step::Nothing,
        }
    }

    /// The pending shrink is due.
    fn shrink_due(&mut self, now: Instant) -> Option<Duration> {
        let at = self.shrink_at?;
        if now >= at {
            self.shrink_at = None;
            None
        } else {
            Some(at - now)
        }
    }
}

/// Show `next` (None closes the panel). `instant` closes without the morph,
/// as Escape does.
pub fn request_panel(app: &mut App, tx: &mut Tx, next: Option<Panel>, instant: bool) {
    match app.ui.player.mini.request(next, instant) {
        Step::Nothing => {}
        Step::Grow => {
            app.ui.player.mini.anchor = window_bridge::mini_player_panel_anchor(app);
            match window_bridge::set_mini_player_panel(app, tx, true) {
                Some(anchor) => app.ui.player.mini.anchor = anchor,
                None => {
                    let m = &mut app.ui.player.mini;
                    m.requested = None;
                    m.panel = None;
                }
            }
        }
        Step::ShrinkNow => {
            tx.instant();
            window_bridge::set_mini_player_panel(app, tx, false);
        }
        Step::ShrinkAfterMorph => tx.wake_after(CLOSE_MORPH),
    }
    super::lyrics::sync(app);
}

/// Every frame: shrink the window once the closing morph is done, and shut
/// the error panel when the failure it shows goes.
pub fn poll(app: &mut App, tx: &mut Tx, failed: bool) -> bool {
    let m = &mut app.ui.player.mini;
    if !m.on {
        return false;
    }
    let mut changed = false;
    if m.shrink_at.is_some() {
        match m.shrink_due(Instant::now()) {
            Some(wait) => tx.wake_after(wait),
            None => {
                window_bridge::set_mini_player_panel(app, tx, false);
                changed = true;
            }
        }
    }
    if !failed && app.ui.player.mini.requested == Some(Panel::Error) {
        request_panel(app, tx, None, false);
        changed = true;
    }
    changed
}

// ---- views ----

/// The utility row's icons in the mini player (13 px).
pub const UTIL_ICON: f32 = 13.0;

/// The mini player: the whole window is the bar.
pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let [w, h] = crate::shell::window_size(cx);
    let m = &app.ui.player.mini;
    let card = match m.panel {
        Some(panel) => panel_layout(app, t, cx, panel),
        None => {
            let card = bar_layout(app, t, w, h);
            match m.bar_height {
                Some(bh) => card.h(bh.min(h)),
                None => card.h_full(),
            }
        }
    };
    let mut shell = col().key("player-shell").w_full().h_full();
    if m.panel.is_none() && m.anchor == Anchor::Bottom {
        // The window grew upward for the panel: the bar stays on the bottom edge.
        shell = shell.justify_end();
    }
    shell = shell.child(card);
    if let Some(notice) = super::devices::remote_indicator(app, t, true) {
        shell = shell.child(notice);
    }
    shell
}

/// `.player-bar` in the mini player: a draggable card filling the window.
fn card(t: &Theme, pad: f32) -> El {
    css_border(row(), 1.0, t.c.border, t.radius_xl())
        .key("player-bar")
        .w_full()
        .padding(pad + 1.0)
        .radius(t.radius_xl())
        .fill(t.c.background)
        .label("Player")
        .window_drag()
}

/// A line held in a box of its CSS line height, as wide as its column
/// (centred in it when `centred`).
fn held(e: El, lh: f32, centred: bool) -> El {
    let r = row().h(lh).w_full().min_w(0.0).child(e);
    if centred { r.justify_center() } else { r }
}

/// The track's title and artist (`.np-text`): `title` and `artist` sizes.
fn np_text(app: &App, t: &Theme, title: f32, artist: f32, gap: f32, centred: bool) -> El {
    let d = display::display(app);
    let title_lh = (title * 1.15 * 100.0).round() / 100.0;
    let artist_lh = artist * 1.25;
    let title_style = with_lh(font(title, 600.0), title_lh).tracking(-0.01 * title);
    let artist_style = with_lh(font(artist, 400.0), artist_lh);
    let underline = super::error::underline_at(artist, artist_lh);
    let mut c = col()
        .key("np-text")
        .min_w(0.0)
        .gap(gap)
        .child(held(crate::ui::line(d.title.clone(), title_style, t.c.foreground).tip_truncated("np-title", &d.title, title_style).matched("mini-title"), title_lh, centred))
        .child(held(bar::np_artist(app, t, artist_style, underline).matched("mini-artist"), artist_lh, centred));
    if centred {
        c = c.items_center();
    }
    c
}

/// The mini player's transport row: 30 px buttons, a 40 px play button.
fn transport_size(compact: bool) -> TransportSize {
    TransportSize { btn: 30.0, gap: 2.0, play: 40.0, play_icon: 18.0, play_margin: 6.0, compact }
}


/// `.utility` in the mini player: 28 px buttons 2 px apart, a divider, the
/// volume, and the outlined toggle.
fn utility(app: &App, t: &Theme, compact: bool, tiny: bool) -> El {
    let mut u = row()
        .key("utility")
        .gap(2.0)
        .items_center()
        .matched("mini-utility")
        .child(super::devices::button(app, t));
    if !tiny {
        u = u.child(bar::favorite_button(app, t, UTIL_ICON, 28.0));
    }
    u = u.child(bar::lyrics_button(app, t)).child(super::queue::button(app, t));
    if !compact {
        u = u
            .child(el().key("mini-divider").w(1.0).h(16.0).mx(6.0).fill(t.c.border))
            .child(bar::volume(app, t, 108.0, 6.0, 24.0, 12.0, 3.0));
    }
    u.child(bar::mini_toggle(app, t))
}

/// The bar without a panel: the cover spanning both rows, the track above
/// the transport and progress, the utility row top right.
fn bar_layout(app: &App, t: &Theme, w: f32, h: f32) -> El {
    // `max-width: 640px` and `430px` rework the bar for narrow windows.
    let compact = w <= 640.0;
    let tiny = w <= 430.0;
    let (pad, col_gap, row_gap) = if compact { (8.0, 8.0, 4.0) } else { (12.0, 12.0, 6.0) };
    let art = if compact { (h - 16.0).clamp(48.0, 96.0) } else { (h - 24.0).clamp(48.0, 152.0) };
    let (title, artist) = if compact { ((w * 0.04).clamp(13.0, 18.0), 12.0) } else { (18.0, 14.0) };
    let head = el()
        .grow(1.0)
        .min_w(0.0)
        .h_full()
        .pr(if compact { 0.0 } else { 8.0 })
        .items_center()
        .child(np_text(app, t, title, artist, 4.0, false));
    let util = utility(app, t, compact, tiny);
    let row1 = row()
        .grow(1.0)
        .min_h(0.0)
        .gap(col_gap)
        .items_start()
        .child(head)
        .child(if compact { util.self_center() } else { util });
    let controls = bar::transport_row(app, t, transport_size(tiny)).matched("mini-transport");
    let mut row2 = row().gap(col_gap).items_center().child(controls);
    if !compact {
        row2 = row2.child(
            row()
                .key("progress")
                .grow(1.0)
                .min_w(0.0)
                .pl(8.0)
                .gap(10.0)
                .items_center()
                .child(bar::live_time_label(t, "elapsed", &app.ui.player.progress.elapsed, 36.0, Align::Start).matched("mini-elapsed"))
                .child(bar::seek(app, t).matched("mini-seek"))
                .child(bar::live_time_label(t, "remaining", &app.ui.player.progress.remaining, 36.0, Align::End).matched("mini-remaining")),
        );
    }
    let right = col().key("mini-bar-right").grow(1.0).min_w(0.0).h_full().gap(row_gap).child(row1).child(row2);
    let np_art = bar::np_art(app, t, art, t.radius_xl()).matched("mini-art");
    bar::np_context(app, card(t, pad).gap(col_gap).items_center().child(np_art).child(right))
}

/// The panel layout: a 184 px column of cover, track, progress and
/// transport, and the panel's heading and card beside the utility row.
fn panel_layout(app: &App, t: &Theme, cx: &mut Cx<App>, panel: Panel) -> El {
    let column = 184.0;
    let np = col()
        .key("np")
        .w(column)
        .gap(12.0)
        .child(bar::np_art(app, t, column, t.radius_xl()).matched("mini-art"))
        .child(np_text(app, t, 16.0, 13.0, 3.0, true).w_full());
    let np = bar::np_context(app, np);
    let progress = col()
        .key("progress")
        .w_full()
        .gap(8.0)
        .child(row().w_full().h(4.0).child(bar::seek(app, t).matched("mini-seek")))
        .child(
            row()
                .w_full()
                .justify_between()
                .child(bar::live_time_label(t, "elapsed", &app.ui.player.progress.elapsed, 36.0, Align::Start).matched("mini-elapsed"))
                .child(bar::live_time_label(t, "remaining", &app.ui.player.progress.remaining, 36.0, Align::End).matched("mini-remaining")),
        );
    let transport = col()
        .key("transport")
        .w_full()
        .gap(6.0)
        .child(progress)
        .child(bar::transport_row(app, t, transport_size(false)).matched("mini-transport").self_center());
    let left = col().key("mini-panel-left").w(column).h_full().justify_between().child(np).child(transport);

    let m = &app.ui.player.mini;
    let mut head = row()
        .key(format!("mini-panel-head-{}", panel.name()))
        .grow(1.0)
        .min_w(0.0)
        .pl(2.0)
        .gap(8.0)
        .items_center()
        .transition(rune::Transition::asymmetric(rune::Transition::opacity(), rune::Transition::none()))
        .child(super::centred(crate::ui::line(panel.title(), font(14.0, 600.0), t.c.foreground), 20.3));
    match panel {
        Panel::Queue => {
            if let Some(pos) = super::queue::position(app) {
                head = head.child(position_pill(t, &pos));
            }
        }
        Panel::Devices => head = head.child(status_pill(app, t)),
        _ => {}
    }
    let row1 = row().w_full().gap(16.0).items_center().child(head).child(utility(app, t, false, false));

    let mut content = col().key(format!("mini-panel-{}", panel.name())).w_full().grow(1.0).min_h(0.0);
    content = match panel {
        Panel::Queue => {
            let mut c = content;
            for part in super::queue::list(app, t, cx, "mini-queue", false) {
                c = c.child(part);
            }
            c
        }
        Panel::Lyrics => {
            let c = content.justify_center();
            if app.player.current().is_none() {
                c.child(
                    el().w_full().px(16.0).child(
                        text("Nothing playing")
                            .font(with_lh(font(14.0, 400.0), 18.9))
                            .color(t.c.muted_foreground)
                            .wrap()
                            .align(Align::Center)
                            .w_full(),
                    ),
                )
            } else {
                c.child(super::lyrics::content(app, t, cx, "mini-lyrics-scroll", true))
            }
        }
        Panel::Error => {
            let w = cx.layout_size("mini-panel-body").map_or(500.0, |s| s[0] - 2.0);
            content.child(super::auto_scroll(t, cx, "mini-error-scroll", super::error::details(app, t, w)).grow(1.0).min_h(0.0))
        }
        Panel::Devices => {
            let mut c = col().w_full();
            let w = cx.layout_size("mini-panel-body").map_or(500.0, |s| s[0] - 2.0);
            for part in super::devices::list(app, t, "mini-devices", false, w) {
                c = c.child(part);
            }
            content.child(super::auto_scroll(t, cx, "mini-devices-scroll", c).grow(1.0).min_h(0.0))
        }
    };
    if let Some(swap) = m.enter {
        // A panel swapped in for another slides in from its button's side.
        let dx = if swap == Swap::Forward { 16.0 } else { -16.0 };
        content = content.transition(rune::Transition::asymmetric(
            rune::Transition::offset(dx, 0.0).combined(rune::Transition::opacity()),
            rune::Transition::none(),
        ));
    } else {
        content = content.transition(rune::Transition::asymmetric(rune::Transition::opacity(), rune::Transition::none()));
    }
    // The panel's card grows out of the corner its buttons sit in.
    let corner = rune::Vec2::new(1.0, if m.anchor == Anchor::Top { 0.0 } else { 1.0 });
    let body = css_border(col(), 1.0, t.c.border, t.radius_lg())
        .key("mini-panel-body")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .padding(1.0)
        .radius(t.radius_lg())
        .fill(t.c.card)
        .role("region")
        .label(panel.label())
        .transition(rune::Transition::scale_anchor(0.92, corner))
        .child(content);
    let right = col().key("mini-panel-right").grow(1.0).min_w(0.0).h_full().gap(10.0).child(row1).child(body);
    card(t, 12.0).h_full().gap(16.0).child(left).child(right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_grows_the_window_and_pins_the_bar() {
        let mut m = Mini { on: true, ..Mini::default() };
        assert_eq!(m.request(Some(Panel::Queue), false), Step::Grow);
        assert_eq!((m.panel, m.requested, m.bar_height), (Some(Panel::Queue), Some(Panel::Queue), Some(184.0)));
    }

    #[test]
    fn swapping_slides_from_the_buttons_side() {
        let mut m = Mini { on: true, ..Mini::default() };
        m.request(Some(Panel::Lyrics), false);
        assert_eq!(m.request(Some(Panel::Queue), false), Step::Nothing);
        assert_eq!(m.enter, Some(Swap::Forward));
        m.request(Some(Panel::Error), false);
        assert_eq!((m.panel, m.enter), (Some(Panel::Error), Some(Swap::Back)));
    }

    #[test]
    fn closing_morphs_then_shrinks_and_escape_shrinks_at_once() {
        let mut m = Mini { on: true, ..Mini::default() };
        m.request(Some(Panel::Devices), false);
        assert_eq!(m.request(None, false), Step::ShrinkAfterMorph);
        assert_eq!((m.panel, m.requested), (None, None));
        // The bar keeps its own height while the window is still grown.
        assert_eq!(m.bar_height, Some(184.0));
        assert!(m.shrink_due(Instant::now()).is_some());
        assert!(m.shrink_due(Instant::now() + CLOSE_MORPH).is_none());
        m.request(Some(Panel::Devices), false);
        assert_eq!(m.request(None, true), Step::ShrinkNow);
        assert!(m.shrink_at.is_none());
    }

    #[test]
    fn reopening_before_the_shrink_keeps_the_grown_window() {
        let mut m = Mini { on: true, ..Mini::default() };
        m.request(Some(Panel::Queue), false);
        m.request(None, false);
        assert_eq!(m.request(Some(Panel::Lyrics), false), Step::Nothing);
        assert_eq!(m.panel, Some(Panel::Lyrics));
        assert!(m.shrink_at.is_none());
    }
}
