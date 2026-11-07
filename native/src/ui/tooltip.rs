//! `TitleTooltips.tsx`, `Tooltip.tsx` and `lib/tooltipTiming.ts`
//! (`tooltip.css`): the app's own tooltips, in place of native `title`s.
//!
//! [`tip`] gives an element one: resting on it for [`OPEN_DELAY`] shows the
//! bubble above it (below, or beside with [`Side::Right`], when that's where
//! it fits), 8 px inside the window, with an arrow at the element's centre.
//! Within [`SKIP_DELAY_WINDOW`] of another closing it shows at once and
//! without its fade, as the same hint moving along a row. Escape hides it
//! until the pointer leaves. [`tip_truncated`] is a truncation hint: it shows
//! only while its text is cut short. [`tip_body`] takes rich content (the
//! "Also known as" list).
//!
//! The layer is drawn by [`view`] above every overlay; [`poll`] opens a
//! bubble once its delay is up.

use rune::{Cx, El, TextStyle, col, el, text};
use rune_motion::{Effect, Spring, SpringPair, Transition, Vec2};

use crate::app::App;
use crate::theme::Theme;
use crate::ui::{font, with_lh};

/// `OPEN_DELAY`: how long the pointer rests before a tooltip shows (s).
pub const OPEN_DELAY: f64 = 0.5;
/// `SKIP_DELAY_WINDOW`: after one closes, the next opens at once (s).
pub const SKIP_DELAY_WINDOW: f64 = 0.3;
const GAP: f32 = 6.0;
const EDGE: f32 = 8.0;

/// `data-tooltip-side`: where the bubble prefers to go.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Side {
    #[default]
    Top,
    Bottom,
    Right,
}

/// What a bubble holds.
#[derive(Clone, Debug, PartialEq)]
pub enum Body {
    Text(String),
    /// The track list's aka hint: "Also known as", each name, and "Click to
    /// compare versions" when a click does that.
    AlsoKnownAs { names: Vec<String>, hint: bool },
}

#[derive(Clone, Debug, PartialEq)]
struct Tip {
    key: String,
    body: Body,
    side: Side,
    /// A truncation hint for text set in this style: shown only when clipped.
    clipped: Option<TextStyle>,
}

/// The layer's state: what the pointer rests on and whether its bubble is up.
#[derive(Debug)]
pub struct State {
    /// Tooltip elements the pointer is inside, outermost first; the last one
    /// is the one that shows.
    inside: Vec<Tip>,
    /// When the pointer reached the active one (clock seconds).
    since: f64,
    shown: bool,
    instant: bool,
    /// Escape hid it; it stays hidden until the pointer leaves.
    dismissed: bool,
    /// `markTooltipClosed`'s time.
    last_closed: f64,
    /// The app clock at the last poll.
    clock: f64,
}

impl Default for State {
    fn default() -> Self {
        State {
            inside: Vec::new(),
            since: 0.0,
            shown: false,
            instant: false,
            dismissed: false,
            last_closed: f64::NEG_INFINITY,
            clock: 0.0,
        }
    }
}

impl State {
    fn release(&mut self) {
        if self.shown {
            self.last_closed = self.clock;
        }
        self.shown = false;
        self.instant = false;
    }

    /// The active tip changed: wait out the delay again, or skip it.
    fn engage(&mut self, tx: &mut rune::Tx) {
        self.dismissed = false;
        if self.clock - self.last_closed < SKIP_DELAY_WINDOW {
            self.shown = true;
            self.instant = true;
        } else {
            self.shown = false;
            self.since = self.clock;
            tx.wake_after(std::time::Duration::from_secs_f64(OPEN_DELAY));
        }
    }

    fn hovered(&mut self, tip: Tip, inside: bool, tx: &mut rune::Tx) {
        let at = self.inside.iter().position(|t| t.key == tip.key);
        if inside {
            if let Some(at) = at {
                // A label update while hovered (Play/Pause): show the new text.
                self.inside[at] = tip;
                return;
            }
            self.release();
            self.inside.push(tip);
            self.engage(tx);
        } else if let Some(at) = at {
            let active = at + 1 == self.inside.len();
            self.inside.remove(at);
            if active {
                self.release();
                if !self.inside.is_empty() {
                    self.engage(tx);
                }
            }
        }
    }
}

fn attach(e: El, tip: Tip) -> El {
    e.key(tip.key.clone()).on_hover_change(move |app: &mut App, inside, tx| app.widgets.tooltip.hovered(tip.clone(), inside, tx))
}

/// The app's tooltip on `e` (keyed `key`, which the bubble anchors to): the
/// web's `title=` / an icon button's `aria-label`.
pub fn tip(e: El, key: &str, text: &str) -> El {
    tip_side(e, key, text, Side::Top)
}

/// [`tip`] preferring `side` (`data-tooltip-side="right"` on the rail).
pub fn tip_side(e: El, key: &str, text: &str, side: Side) -> El {
    if text.trim().is_empty() {
        return e.key(key);
    }
    attach(e, Tip { key: key.into(), body: Body::Text(text.trim().into()), side, clipped: None })
}

/// A truncation hint: `e` shows `text` set in `style`, and the tooltip
/// repeats it only while the element is too narrow to show it whole.
pub fn tip_truncated(e: El, key: &str, text: &str, style: TextStyle) -> El {
    if text.trim().is_empty() {
        return e.key(key);
    }
    attach(e, Tip { key: key.into(), body: Body::Text(text.trim().into()), side: Side::Top, clipped: Some(style) })
}

/// `<Tooltip content={…}>`: rich content.
pub fn tip_body(e: El, key: &str, body: Body) -> El {
    attach(e, Tip { key: key.into(), body, side: Side::Top, clipped: None })
}

/// `.tip(key, text)` on any element: [`tip`] with the element's own key.
pub trait TipExt {
    /// The app's tooltip (`title=`); `key` must be the element's key.
    fn tip(self, key: &str, text: &str) -> El;
    /// [`TipExt::tip`] preferring `side`.
    fn tip_side(self, key: &str, text: &str, side: Side) -> El;
    /// A truncation hint (see [`tip_truncated`]).
    fn tip_truncated(self, key: &str, text: &str, style: TextStyle) -> El;
}

impl TipExt for El {
    fn tip(self, key: &str, text: &str) -> El {
        tip(self, key, text)
    }
    fn tip_side(self, key: &str, text: &str, side: Side) -> El {
        tip_side(self, key, text, side)
    }
    fn tip_truncated(self, key: &str, text: &str, style: TextStyle) -> El {
        tip_truncated(self, key, text, style)
    }
}

/// Runs before each frame: opens the waiting bubble once its delay is up.
pub fn poll(app: &mut App, clock: f64) -> bool {
    let s = &mut app.widgets.tooltip;
    s.clock = clock;
    if !s.shown && !s.dismissed && !s.inside.is_empty() && clock + 1e-6 >= s.since + OPEN_DELAY {
        s.shown = true;
        s.instant = false;
        return true;
    }
    false
}

/// Escape hides the bubble (it stays hidden until the pointer leaves).
/// Never takes the key.
pub fn on_key(app: &mut App, ev: &rune::KeyEvent) -> bool {
    if matches!(ev.key, rune::Key::Escape) {
        dismiss(app);
    }
    false
}

/// A click, scroll or Escape: hide the bubble until the pointer leaves.
pub fn dismiss(app: &mut App) {
    let s = &mut app.widgets.tooltip;
    if !s.inside.is_empty() {
        s.dismissed = true;
        s.shown = false;
        s.last_closed = f64::NEG_INFINITY;
    }
}

/// The bubble, placed by `TooltipBubble`'s rules, or None.
pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let s = &app.widgets.tooltip;
    let tip = s.inside.last()?;
    if !s.shown || s.dismissed {
        return None;
    }
    let anchor = cx.window_layout(&tip.key)?;
    if let (Some(style), Body::Text(text)) = (tip.clipped, &tip.body) {
        let (natural, _) = rune::text::measure(text, &[], style, None);
        if natural <= anchor[2] + 1.0 {
            return None;
        }
    }
    let window = crate::shell::window_size(cx);
    let size = cx.layout_size("tooltip-bubble").unwrap_or([0.0, 0.0]);
    let (x, y, side, arrow) = place(anchor, size, tip.side, window);
    Some(bubble(t, &tip.body, side, arrow, size, s.instant).absolute(x, y))
}

/// `TooltipBubble`'s placement: (x, y, the side it went to, the arrow's
/// offset along the edge facing the anchor).
fn place(a: [f32; 4], tr: [f32; 2], side: Side, win: [f32; 2]) -> (f32, f32, Side, f32) {
    let [ax, ay, aw, ah] = a;
    let mut resolved = side;
    let (mut x, mut y) = (0.0, 0.0);
    if side == Side::Right {
        x = ax + aw + GAP;
        y = ay + ah / 2.0 - tr[1] / 2.0;
        if x + tr[0] > win[0] - EDGE {
            resolved = Side::Top;
        }
    }
    if resolved != Side::Right {
        x = ax + aw / 2.0 - tr[0] / 2.0;
        let above = ay - tr[1] - GAP;
        let below = ay + ah + GAP;
        if resolved == Side::Top && above < EDGE {
            resolved = Side::Bottom;
        } else if resolved == Side::Bottom && below + tr[1] > win[1] - EDGE {
            resolved = Side::Top;
        }
        y = if resolved == Side::Top { above } else { below };
    }
    x = x.max(EDGE).min(win[0] - tr[0] - EDGE);
    y = y.max(EDGE).min(win[1] - tr[1] - EDGE);
    let arrow = if resolved == Side::Right { ay + ah / 2.0 - y } else { ax + aw / 2.0 - x };
    (x, y, resolved, arrow)
}

/// `.tooltip`: the foreground-coloured bubble and its arrow.
fn bubble(t: &Theme, body: &Body, side: Side, arrow: f32, size: [f32; 2], instant: bool) -> El {
    let ink = t.c.background;
    let style = with_lh(font(12.0, 400.0), 16.2);
    let content = match body {
        // One line keeps the browser's 16.2 px (Rune rounds a text up to 17).
        Body::Text(s) if rune::text::advance(s, style) <= 320.0 - 24.0 => crate::ui::exact(text(s.clone()).font(style).color(ink), 16.2),
        Body::Text(s) => text(s.clone()).font(style).color(ink).wrap_anywhere(),
        Body::AlsoKnownAs { names, hint } => {
            let mut c = col().gap(2.0).child(text("Also known as").font(with_lh(font(12.0, 500.0), 16.2)).color(t.c.muted_foreground));
            for n in names {
                c = c.child(text(n.clone()).font(style).color(ink).wrap_anywhere());
            }
            if *hint {
                c = c.child(text("Click to compare versions").font(style).color(t.c.muted_foreground).mt(4.0));
            }
            c
        }
    };
    // `::after`: an 8 px square turned 45°, its centre 1 px inside the edge
    // that faces the trigger, at the trigger's centre (10 px from the ends).
    let diamond = |cx: f32, cy: f32| el().absolute(cx - 4.0, cy - 4.0).size(8.0, 8.0).radius(2.0).fill(t.c.foreground).rotate(std::f32::consts::FRAC_PI_4);
    let b = el()
        .key("tooltip-bubble")
        .max_w(320.0)
        .px(12.0)
        .py(6.0)
        .radius(t.radius_md())
        .fill(t.c.foreground)
        .role("tooltip")
        .inert()
        .child(content);
    // The arrow needs the bubble's size, which the layout read settles.
    let (dx, dy) = match side {
        Side::Top => (0.0, 2.0),
        Side::Bottom => (0.0, -2.0),
        Side::Right => (-2.0, 0.0),
    };
    let fade = Effect { opacity: 0.0, scale: 0.97, offset: Vec2::new(dx, dy), ..Effect::IDENTITY };
    let spring = if instant { Spring::NONE } else { Spring::new(0.1, 0.0) };
    let transition = Transition { insertion: fade, removal: fade, ..Transition::scale(0.97) }.springs(SpringPair::new(spring, spring));
    let along = |extent: f32| arrow.min(extent - 10.0).max(10.0);
    let arrow_el = match side {
        Side::Top => diamond(along(size[0]), size[1] - 1.0),
        Side::Bottom => diamond(along(size[0]), 1.0),
        Side::Right => diamond(1.0, along(size[1])),
    };
    b.child(arrow_el).transition(transition)
}
