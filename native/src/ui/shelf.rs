//! `ShelfScroller.tsx` and `lib/useScrollEdges.ts` (`home.css`): a row of
//! cards that scrolls sideways without a scrollbar. Its edges fade wherever
//! there's more to scroll to, and while it's hovered round arrow buttons page
//! through it (most of a screen per press).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use rune::{Color, Cursor, El, Live, ScrollPos, Shadow, el, row};

use crate::app::App;
use crate::theme::Theme;
use crate::ui::{ico, icons as i, motion};

/// `--shelf-col`: a card's width in a shelf.
pub const SHELF_COL: f32 = 168.0;
/// `--shelf-fade`.
const FADE: f32 = 48.0;

/// Each shelf's scroll position and edge flags, by key. The scroll
/// callback updates them without a view run; the arrows read them.
#[derive(Default)]
pub struct Shelves {
    map: RefCell<HashMap<String, Edges>>,
}

#[derive(Clone)]
struct Edges {
    /// offset, max, viewport width.
    pos: Rc<Cell<[f32; 3]>>,
    back: Live<f32>,
    forward: Live<f32>,
}

impl Shelves {
    fn edges(&self, key: &str) -> Edges {
        self.map
            .borrow_mut()
            .entry(key.to_string())
            .or_insert_with(|| Edges { pos: Rc::new(Cell::new([0.0; 3])), back: Live::new(0.0), forward: Live::new(0.0) })
            .clone()
    }
}

/// `ShelfScroller`: `cards` in a sideways row, each `col` px wide (168, or
/// the page's `--shelf-col`), `label` naming the row ("Top artists").
pub fn shelf(app: &App, t: &Theme, key: &str, label: &str, cards: Vec<El>, col: f32) -> El {
    let edges = app.widgets.shelves.edges(key);
    let viewport_key = format!("{key}-shelf");
    let feed = edges.clone();
    let mut strip = row().gap(t.gap()).pb(8.0);
    for c in cards {
        strip = strip.child(el().w(col).min_w(col).child(c));
    }
    let viewport = row()
        .key(viewport_key.clone())
        .w_full()
        .scroll_x()
        .scroll_edge_fade(FADE)
        .role("group")
        .label(label)
        .on_scroll_offset(move |at: ScrollPos| {
            // A pixel of slack: fractional sizes stop just short of either end.
            feed.pos.set([at.offset[0], at.max[0], at.viewport[0]]);
            feed.back.set(if at.offset[0] > 1.0 { 1.0 } else { 0.0 });
            feed.forward.set(if at.offset[0] < at.max[0] - 1.0 { 1.0 } else { 0.0 });
        })
        .child(strip);
    let arrow = |dir: f32, live: Live<f32>| {
        let pos = edges.pos.clone();
        let vk = viewport_key.clone();
        let glyph = if dir < 0.0 { &i::CHEVRON_LEFT } else { &i::CHEVRON_RIGHT };
        let a = t.c.shadow_md_alpha;
        let b = crate::ui::css_border(el(), 1.0, t.c.border, 999.0)
            .key(format!("{key}-arrow-{}", if dir < 0.0 { "back" } else { "forward" }))
            .size(32.0, 32.0)
            .radius(999.0)
            .fill(t.c.popover)
            .center()
            .box_shadow(Shadow { x: 0.0, y: 4.0, blur: 6.0, spread: -1.0, color: Color::BLACK.alpha(a), inset: false })
            .box_shadow(Shadow { x: 0.0, y: 2.0, blur: 4.0, spread: -2.0, color: Color::BLACK.alpha(a), inset: false })
            .hover(crate::ui::hover_overlay(t.c.popover, t.c.accent))
            .hover_motion(motion::ease(120.0), motion::ease(120.0))
            .cursor(Cursor::Pointer)
            .a11y_hidden()
            .press_scale(0.95)
            .live_opacity(&live)
            .child(ico(glyph, 16.0, t.c.popover_foreground))
            .on_press_tx(move |_: &mut App, tx| {
                let [offset, max, width] = pos.get();
                let to = (offset + dir * width * 0.8).clamp(0.0, max.max(0.0));
                tx.scroll_to(vk.clone(), to, 0.0);
            });
        // Shown while the scroller is hovered, centred on the covers.
        el().group_opacity(0.0, 1.0).child(b)
    };
    let top = col / 2.0 - 16.0;
    el().key(key)
        .w_full()
        .hover_group()
        .hover_motion(motion::ease(150.0), motion::ease(150.0))
        .child(viewport)
        .child(arrow(-1.0, edges.back.clone()).absolute(4.0, top))
        .child(arrow(1.0, edges.forward.clone()).pin(None, Some(top), Some(4.0), None))
}
