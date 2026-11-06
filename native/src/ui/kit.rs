//! Shared building blocks used across pages and overlays: the web app's
//! scroll areas (with its styled scrollbar), `DialogShell`, menus
//! (`.menu`, `.ctx-menu`), `.segmented`, `Switch`, `.toolbar-group`, and the
//! status primitives (`EmptyState`, `LoadingState`, `ErrorBanner`,
//! `PageHeader`).

use std::cell::RefCell;
use std::collections::HashMap;

use rune::{Color, Cursor, El, Icon, Live, ScrollPos, Shadow, Side, col, el, row, text};

use crate::app::App;
use crate::theme::{Theme, color_mix};
use crate::ui::{BtnState, font, ico, iconbtn, icons as i, line, motion, with_lh};
use crate::ui::tooltip::TipExt;

thread_local! {
    static THUMBS: RefCell<HashMap<String, Live<[f32; 4]>>> = RefCell::new(HashMap::new());
}

fn thumb_live(key: &str) -> Live<[f32; 4]> {
    THUMBS.with(|m| m.borrow_mut().entry(key.to_string()).or_insert_with(|| Live::new([0.0, 0.0, 0.0, 0.0])).clone())
}

/// A vertical scroll viewport with the web app's scrollbar (`base.css`):
/// a 10 px gutter that is always reserved (`scrollbar-gutter: stable`, as
/// `.content` has) holding a 6 px pill in `--border` (`--input` on hover),
/// inset 2 px, shown while the content overflows. `content` is laid out
/// 10 px narrower than the area. Grow or size the result like any box.
pub fn scroll_area(t: &Theme, key: &str, content: El) -> El {
    scroll_area_with(t, key, content, true)
}

/// [`scroll_area`] without the reserved gutter: the bar overlays the
/// content's right edge (plain `overflow: auto`, which on Windows also
/// takes 10 px, but only while overflowing).
pub fn scroll_area_with(t: &Theme, key: &str, content: El, stable_gutter: bool) -> El {
    let live = thumb_live(key);
    let feed = live.clone();
    let viewport = col()
        .key(key)
        .grow(1.0)
        .min_h(0.0)
        .min_w(0.0)
        .h_full()
        .scroll(rune::ScrollSpec { stick_bottom: false })
        .on_scroll_offset(move |at: ScrollPos| {
            let [_, vh] = at.viewport;
            let content_h = vh + at.max[1];
            if at.max[1] <= 0.5 || vh <= 0.0 {
                feed.set([0.0, 0.0, 0.0, 0.0]);
                return;
            }
            // Chromium: thumb length is track × visible / total, at least 18 px
            // (the webkit custom scrollbar minimum), placed in proportion.
            let track = vh;
            let len = (track * vh / content_h).max(18.0).min(track);
            let y = (at.offset[1] / at.max[1]).clamp(0.0, 1.0) * (track - len);
            // The 2 px transparent border with padding-box clip insets the pill.
            feed.set([2.0, y + 2.0, 6.0, (len - 4.0).max(0.0)]);
        })
        .child(content.w_full());
    let thumb = el()
        .key(format!("{key}-thumb"))
        .absolute(0.0, 0.0)
        .live_rect(&live)
        .radius(99.0)
        .fill(t.c.border)
        .hover(crate::ui::hover_overlay(t.c.border, t.c.input));
    let gutter = el().key(format!("{key}-gutter")).w(10.0).h_full().child(thumb);
    if stable_gutter {
        row().key(format!("{key}-area")).min_h(0.0).min_w(0.0).child(viewport).child(gutter)
    } else {
        row()
            .key(format!("{key}-area"))
            .min_h(0.0)
            .min_w(0.0)
            .child(viewport)
            .child(gutter.pin(None, Some(0.0), Some(0.0), Some(0.0)))
    }
}

/// `DialogShell`: the scrim and a centred panel (`.dialog`, `max-w-lg` =
/// 512 px unless `max_width`, at most 80% of the window high) with an
/// optional header (title + close button) over `body` and `footer`. Escape
/// and a click on the scrim call `close`. Mount it at the view's root (it's
/// placed by `crate::overlays`).
pub struct Dialog {
    pub key: String,
    pub title: Option<String>,
    pub max_width: f32,
    pub body: El,
    pub footer: Option<El>,
}

impl Dialog {
    pub fn new(key: impl Into<String>, body: El) -> Dialog {
        Dialog { key: key.into(), title: None, max_width: 512.0, body, footer: None }
    }
    pub fn title(mut self, title: impl Into<String>) -> Dialog {
        self.title = Some(title.into());
        self
    }
    pub fn max_width(mut self, w: f32) -> Dialog {
        self.max_width = w;
        self
    }
    pub fn footer(mut self, footer: El) -> Dialog {
        self.footer = Some(footer);
        self
    }

    pub fn build(self, t: &Theme, window: [f32; 2], close: fn(&mut App)) -> El {
        let r = t.radius_xl();
        let mut panel = crate::ui::css_border(col(), 1.0, t.c.border, r)
            .key(format!("{}-panel", self.key))
            .w_full()
            .max_w(self.max_width)
            .max_h(window[1] * 0.8)
            .padding(1.0)
            .radius(r)
            .fill(t.c.popover)
            .clip_rounded(r)
            .role("dialog")
            .transition(rune::Transition::scale(0.95));
        if let Some(title) = self.title {
            let close_btn = iconbtn(t, &format!("{}-close", self.key), &i::X, 14.0, BtnState::default())
                .label("Close")
                .tip(&format!("{}-close", self.key), "Close")
                .on_press(close);
            panel = panel.child(
                crate::ui::css_border_bottom(row(), 1.0, t.c.border)
                    .px(16.0)
                    .py(12.0)
                    .pb(13.0)
                    .items_center()
                    .justify_between()
                    .child(text(title).font(font(14.0, 600.0)).color(t.c.popover_foreground))
                    .child(close_btn),
            );
        }
        panel = panel.child(col().grow(1.0).min_h(0.0).child(self.body));
        if let Some(f) = self.footer {
            panel = panel.child(f);
        }
        el().key(self.key)
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .center()
            .padding(16.0)
            .modal(true, close)
            .child(
                el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .fill(t.c.scrim)
                    .transition(rune::Transition::opacity())
                    .on_press(close),
            )
            .child(panel)
    }
}

/// `DialogFooter`: a bordered bar with buttons on the right, and optionally
/// something on the left.
pub fn dialog_footer(t: &Theme, start: Option<El>, buttons: Vec<El>) -> El {
    let mut right = row().gap(8.0).items_center();
    for b in buttons {
        right = right.child(b);
    }
    let mut bar = crate::ui::css_border(row(), 0.0, Color::TRANSPARENT, 0.0)
        .child(el().pin(Some(0.0), Some(0.0), Some(0.0), None).h(1.0).fill(t.c.border).inert())
        .px(16.0)
        .pt(11.0)
        .pb(10.0)
        .gap(8.0)
        .items_center();
    bar = match start {
        Some(s) => bar.justify_between().child(s),
        None => bar.justify_end(),
    };
    bar.child(right)
}

/// `.menu` / `.ctx-menu`: the popover box menus and popovers share.
pub fn menu_panel(t: &Theme, key: &str, width: Option<f32>) -> El {
    let r = t.radius_lg();
    let a = t.c.shadow_md_alpha;
    let mut m = crate::ui::css_border(col(), 1.0, t.c.border, r)
        .key(key)
        .padding(5.0)
        .radius(r)
        .fill(t.c.popover)
        .box_shadow(Shadow { x: 0.0, y: 4.0, blur: 6.0, spread: -1.0, color: Color::BLACK.alpha(a), inset: false })
        .box_shadow(Shadow { x: 0.0, y: 2.0, blur: 4.0, spread: -2.0, color: Color::BLACK.alpha(a), inset: false })
        .clip_rounded(r)
        .transition(rune::Transition::scale(0.96))
        .role("menu");
    m = match width {
        Some(w) => m.w(w),
        None => m.min_w(220.0),
    };
    m
}

/// `.ctx-item` / `.menu-item`: icon, label, and an optional trailing hint.
pub fn menu_item(t: &Theme, key: &str, glyph: Option<&'static Icon>, label: &str, hint: Option<&str>, disabled: bool) -> El {
    let mut it = row()
        .key(key)
        .w_full()
        .min_h(28.0)
        .px(6.0)
        .py(4.0)
        .gap(6.0)
        .items_center()
        .radius(t.radius_md())
        .role("menuitem")
        .label(label);
    if let Some(g) = glyph {
        it = it.child(ico(g, 14.0, t.c.popover_foreground).group_color(t.c.accent_foreground));
    }
    it = it.child(line(label, font(14.0, 400.0), t.c.popover_foreground).group_color(t.c.accent_foreground).grow(1.0));
    if let Some(h) = hint {
        it = it.child(text(h).font(font(12.0, 400.0)).color(t.c.muted_foreground));
    }
    if disabled {
        it.opacity(0.5).disabled(true)
    } else {
        it.hover(t.c.accent).focus_highlight(t.c.accent).press_scale(0.98).focusable(true)
    }
}

/// `.ctx-sep`.
pub fn menu_sep(t: &Theme) -> El {
    el().h(1.0).mx(-4.0).my(4.0).fill(t.c.border)
}

/// `.ctx-heading`.
pub fn menu_heading(t: &Theme, label: &str) -> El {
    el().px(6.0).py(4.0).child(text(label).font(font(12.0, 500.0)).color(t.c.muted_foreground))
}

/// Anchor a popover to `anchor_key` (`El::anchored`), below it, start-aligned.
pub fn anchored_below(e: El, anchor_key: &str, gap: f32) -> El {
    e.anchored(anchor_key, Side::Bottom, rune::Align::Start, gap)
}

/// `.segmented`: a pill group whose lit pill travels between options.
pub fn segmented<T: Copy + PartialEq + 'static>(
    t: &Theme,
    key: &str,
    options: &[(T, &str)],
    current: T,
    on_pick: fn(&mut App, T),
) -> El {
    let mut group = row().key(key).h(32.0).padding(3.0).items_center().radius(t.radius_lg()).fill(t.c.muted).role("tablist");
    for (n, (value, label)) in options.iter().enumerate() {
        let active = *value == current;
        let v = *value;
        let mut b = el()
            .key(format!("{key}-{n}"))
            .h_full()
            .px(9.0)
            .radius(t.radius_md())
            .items_center()
            .role("tab")
            .checked(active)
            .cursor(Cursor::Pointer)
            .on_press(move |app: &mut App| on_pick(app, v));
        if active {
            // The travelling indicator: a `matched` pill flies to the new option.
            let mut pill = el()
                .key(format!("{key}-indicator"))
                .matched(format!("{key}-indicator"))
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .radius(t.radius_md())
                // 200 ms ease-in-out in CSS; a critically damped spring of the same length.
                .motion(rune_motion::Spring::new(0.2, 0.0));
            if t.dark() {
                // A CSS border, painted over the pill's own fill.
                pill = crate::ui::css_border(pill.fill(t.c.input_bg), 1.0, t.c.input, t.radius_md());
            } else {
                pill = pill
                    .fill(t.c.background)
                    .box_shadow(Shadow { x: 0.0, y: 1.0, blur: 3.0, spread: 0.0, color: Color::BLACK.alpha(0.1), inset: false })
                    .box_shadow(Shadow { x: 0.0, y: 1.0, blur: 2.0, spread: -1.0, color: Color::BLACK.alpha(0.1), inset: false });
            }
            b = b.child(pill);
        }
        let ink = if active { t.c.foreground } else { t.c.muted_foreground };
        b = b.child(text(*label).font(font(14.0, 500.0)).color(ink).group_color(t.c.foreground));
        if !active {
            b = b.hover(Color::TRANSPARENT).press_scale(0.97);
        }
        group = group.child(b);
    }
    group
}

/// `Switch` (`.switch` in settings.css).
pub fn switch(t: &Theme, key: &str, checked: bool, disabled: bool, on_toggle: impl Fn(&mut App) + 'static) -> El {
    let thumb = el()
        .key(format!("{key}-thumb"))
        .size(16.0, 16.0)
        .radius(999.0)
        .fill(if checked { t.c.primary_foreground } else { t.c.background })
        .shadow(1.0, 2.0, Color::BLACK.alpha(0.25))
        .offset(if checked { 16.0 } else { 0.0 }, 0.0)
        .offset_motion(motion::ease(150.0));
    let mut s = row()
        .key(key)
        .size(36.0, 20.0)
        .padding(2.0)
        .items_center()
        .radius(999.0)
        .fill(if checked { t.c.primary } else { t.c.input })
        .role("switch")
        .checked(checked)
        .child(thumb);
    if disabled {
        s = s.opacity(0.6).disabled(true);
    } else {
        s = s.cursor(Cursor::Pointer).focusable(true).on_press(on_toggle);
    }
    s
}

/// `.toolbar-group`: controls in one muted bar.
pub fn toolbar_group(t: &Theme, key: &str, children: Vec<El>) -> El {
    let mut g = row().key(key).min_h(32.0).padding(3.0).gap(2.0).items_center().radius(t.radius_lg()).fill(t.c.muted);
    for c in children {
        g = g.child(c);
    }
    g
}

/// `.toolbar-group-sep`.
pub fn toolbar_sep(t: &Theme) -> El {
    el().w(1.0).h(14.0).mx(3.0).fill(color_mix(t.c.foreground, 0.14, Color::TRANSPARENT))
}

/// `EmptyState`: icon tile, title and hint, centred.
pub fn empty_state(t: &Theme, glyph: Option<&'static Icon>, title: &str, hint: Option<&str>, action: Option<El>) -> El {
    let mut c = col().w_full().px(24.0).py(48.0).gap(8.0).items_center();
    if let Some(g) = glyph {
        c = c.child(el().size(40.0, 40.0).mb(4.0).radius(t.radius_lg()).fill(t.c.muted).center().child(ico(g, 20.0, t.c.foreground)));
    }
    // `text-align: center` for lines that wrap.
    c = c.child(text(title).font(font(16.0, 500.0)).color(t.c.foreground).wrap().align(rune::Align::Center));
    if let Some(h) = hint {
        c = c.child(text(h).font(font(14.0, 400.0)).color(t.c.muted_foreground).wrap().align(rune::Align::Center));
    }
    if let Some(a) = action {
        c = c.child(a);
    }
    c
}

/// `LoadingState` (`.loading-state mono`: tabular figures).
pub fn loading_state(t: &Theme, label: &str) -> El {
    el().padding(20.0).child(text(label).font(crate::ui::tnum(font(14.0, 400.0))).color(t.c.muted_foreground))
}

/// `ErrorBanner`.
pub fn error_banner(t: &Theme, message: &str) -> El {
    crate::ui::css_border(el(), 1.0, t.c.destructive_border, t.radius_lg())
        .w_full()
        .px(13.0)
        .py(9.0)
        .radius(t.radius_lg())
        .fill(t.c.destructive_soft)
        .child(text(message).font(font(14.0, 400.0)).color(t.c.destructive).wrap())
}

/// `PageHeader`: the 24 px title with an optional muted count after it,
/// baseline-aligned (`.page-header`).
pub fn page_header(t: &Theme, title: &str, count: Option<&str>) -> El {
    let mut h = row().gap(16.0).items_end();
    h = h.child(text(title).font(with_lh(font(24.0, 600.0), 34.8).tracking(-0.6)).color(t.c.foreground));
    if let Some(c) = count {
        h = h.child(text(c).font(font(14.0, 400.0)).color(t.c.muted_foreground).mb(4.0));
    }
    h
}

/// `.eyebrow`: a 12 px medium muted label.
pub fn eyebrow(t: &Theme, s: &str) -> El {
    text(s).font(font(12.0, 500.0)).color(t.c.muted_foreground)
}
