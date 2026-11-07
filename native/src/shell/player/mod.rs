//! The player's UI around the bar: the queue, device and playback-error
//! popovers (`player-popovers.css`), the lyrics column (`LyricsSidebar.tsx`),
//! the mini player window mode (`useMiniPlayerMode.ts`, `MiniPlayerPanel.tsx`)
//! and what the bar shows while another device plays (`usePlayerDisplay.ts`).
//!
//! The popovers open one at a time: in the web app an outside mousedown
//! closes one before the click that opens the next. Here they are modal
//! layers (`El::modal` with outside clicks), so Escape and a click elsewhere
//! close them, and the click that closes one doesn't reach what's under it.
pub mod adapters;
pub mod devices;
pub mod display;
pub mod error;
pub mod lyrics;
pub mod mini;
pub mod progress;
pub mod queue;
pub mod scenes;
pub mod window_bridge;

use rune::{Color, Cursor, El, Key, KeyEvent, Shadow, Tx, col, el, row, text};

use crate::app::App;
use crate::ui::tooltip::TipExt;
use crate::theme::Theme;
use crate::ui::{centred_lh, css_border, css_border_bottom, font, ico, icons as i, nudge_centre};
use crate::ui::ShadowMd;

/// Which popover is open above the bar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Popover {
    Queue,
    Devices,
    Error,
}

/// What the player's UI keeps between frames (`app.ui.player`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    /// The open popover (outside mini mode).
    pub popover: Option<Popover>,
    /// "Copied" on the error details' copy button, for 2 s (`useCopiedFlag`).
    /// "Copied" on the error card's Copy details.
    pub copied: crate::ui::flash::Flag,
    /// Bumped each time the favourite button turns on: replays its heart pop.
    pub fav_pops: u32,
    pub mini: mini::Mini,
    pub lyrics: lyrics::Lyrics,
    /// Playback progress, published from the poll.
    pub progress: progress::Progress,
    /// The window's size outside mini mode, to go back to.
    pub window: Option<(f32, f32)>,
}

/// Open `which`, or close it if it's the open one.
pub fn toggle_popover(app: &mut App, which: Popover) {
    let p = &mut app.ui.player;
    p.popover = if p.popover == Some(which) { None } else { Some(which) };
}

pub fn close_popover(app: &mut App) {
    app.ui.player.popover = None;
}

/// Flash "Copied" for 2 s.
pub fn flash_copied(app: &mut App) {
    crate::ui::flash::flash(app, |app| &mut app.ui.player.copied, 2000);
}

/// Every frame, from `App::poll`: start the lyrics request for a new track,
/// close what went with a failure, and run the mini player's queued steps.
pub fn poll(app: &mut App, clock: f64, tx: &mut Tx) -> bool {
    let mut changed = lyrics::sync(app);
    changed |= progress::publish(app, clock, tx);
    changed |= lyrics::follow(app, tx);
    // The details go with the failure: playing again, or another track,
    // shuts them, so the next failure doesn't open them by itself.
    let failed = display::shown_error(app).is_some();
    if !failed && app.ui.player.popover == Some(Popover::Error) {
        app.ui.player.popover = None;
        changed = true;
    }
    changed |= mini::poll(app, tx, failed);
    changed
}

/// Window keys the player's UI takes before the app's own bindings: Escape
/// closes the mini player's panel.
pub fn on_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    // An open context menu gets the key first.
    if ev.key == Key::Escape && app.ui.player.mini.on && app.ui.player.mini.requested.is_some() && !adapters::track_menu_open(app) {
        mini::request_panel(app, tx, None, true);
        return true;
    }
    false
}

// ---- the popovers' shared chrome (`.device-pop`, `.queue-pop`) ----

/// `.device-pop` / `.queue-pop`: a popover-coloured card with a hairline
/// border, `--radius-lg` and `--shadow-md`, `w` wide. Its exit is the CSS
/// `[data-closed]` state: a fade, 6 px lower and 97% the size, from the
/// corner it opens from.
pub fn pop_box(t: &Theme, key: &str, w: f32, from_left: bool) -> El {
    let r = t.radius_lg();
    let corner = rune::Vec2::new(if from_left { 0.0 } else { 1.0 }, 1.0);
    let enter = rune::Transition::scale_anchor(0.97, corner).combined(rune::Transition::offset(0.0, 6.0));
    css_border(col(), 1.0, t.c.border, r)
        .shadow_md(t)
        .key(key)
        .w(w)
        .padding(1.0)
        .radius(r)
        .fill(t.c.popover)
        .role("dialog")
        .transition(enter)
}

/// A popover's layer: Escape and a click outside close it. `pop` is anchored
/// to its button by the caller.
pub fn pop_layer(key: &str, pop: El) -> El {
    el().key(format!("{key}-layer")).pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).modal(true, close_popover).child(pop)
}

/// `.device-pop-head`: a 44 px header with the title, then whatever goes
/// beside it, a spacer and the close button.
pub fn pop_head(t: &Theme, title: &str, extra: Option<El>, close: El) -> El {
    let mut h = css_border_bottom(row(), 1.0, t.c.border)
        .min_h(44.0)
        .pl(14.0)
        .pr(6.0)
        .pt(6.0)
        .pb(7.0)
        .gap(8.0)
        .items_center()
        .child(centred_lh(text(title).font(font(14.0, 600.0)).color(t.c.popover_foreground), 20.3));
    if let Some(x) = extra {
        h = h.child(x);
    }
    h.child(el().grow(1.0)).child(close)
}

/// `.iconbtn` at 28 px (`.device-pop-close`, `.queue-pop-close`): muted, the
/// foreground on hover (`hover_ink`).
pub fn close_btn(t: &Theme, key: &str, label: &str, hover_ink: bool, on_press: fn(&mut App)) -> El {
    let glyph = ico(&i::X, 14.0, t.c.muted_foreground);
    let glyph = if hover_ink { glyph.group_color(t.c.foreground) } else { glyph };
    el().key(key)
        .size(28.0, 28.0)
        .radius(t.radius_lg())
        .center()
        .role("button")
        .label(label)
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover(t.c.ghost_hover)
        .on_press(on_press)
        .child(glyph)
}

/// `.device-pop-status`: the "Live" pill (`DeviceConnectionStatus`).
pub fn status_pill(app: &App, t: &Theme) -> El {
    let connected = app.player.connected();
    let mut dot = el().size(6.0, 6.0).radius(999.0);
    if connected {
        dot = dot.fill(t.c.success).box_shadow(Shadow {
            x: 0.0,
            y: 0.0,
            blur: 0.0,
            spread: 3.0,
            color: crate::theme::color_mix(t.c.success, 0.22, Color::TRANSPARENT),
            inset: false,
        });
    } else {
        // `device-pop-pulse`: 1.4 s, down to 35% halfway.
        dot = dot.fill(t.c.warning).looping(rune::LoopSpec::cycle(rune::Cycle {
            period: 1.4,
            phase: 0.0,
            stops: &[(0.0, 1.0), (0.5, 0.35), (1.0, 1.0)],
            still: 1.0,
            fps: 30.0,
        }));
    }
    row()
        .key("device-pop-status")
        .h(20.0)
        .px(8.0)
        .gap(6.0)
        .items_center()
        .radius(999.0)
        .fill(t.c.muted)
        .tip("device-pop-status", if connected { "Connected to your server" } else { "Reconnecting to your server" })
        .child(dot)
        .child(centred_lh(text(if connected { "Live" } else { "Reconnecting" }).font(font(12.0, 500.0)).color(t.c.muted_foreground), 17.4))
}

/// `.queue-pop-pos`: "12 / 40".
pub fn position_pill(t: &Theme, position: &str) -> El {
    el().h(18.0)
        .px(5.0)
        .radius(t.radius_sm())
        .fill(t.c.muted)
        .center()
        .child(nudge_centre(centred_lh(text(position).font(crate::ui::tnum(font(12.0, 500.0))).color(t.c.muted_foreground), 17.4), position, crate::ui::tnum(font(12.0, 500.0))))
}

/// `overflow-y: auto` with the app's scrollbar: like Chromium's classic
/// scrollbars, the 10 px gutter takes room only while the content overflows
/// (judged from the last layout).
pub fn auto_scroll(t: &Theme, cx: &mut rune::Cx<App>, key: &str, content: El) -> El {
    let content_key = format!("{key}-content");
    let overflows = match (cx.layout_size(&content_key), cx.layout_size(key)) {
        (Some(c), Some(v)) => c[1] > v[1] + 0.5,
        _ => false,
    };
    crate::ui::kit::scroll_area_with(t, key, content.key(content_key), overflows)
}
