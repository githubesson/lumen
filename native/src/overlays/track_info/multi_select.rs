//! `MultiSelect.tsx` (`forms.css`): the many-valued sibling of `Select`. The
//! same trigger, listbox, keys and dismissal, but picking an option toggles
//! it and leaves the list open; the last selected option can't be unticked.

use rune::{Align, Cursor, El, Side, col, el, row, text};

use crate::app::App;
use crate::theme::Theme;
use crate::ui::kit::{menu_panel, scroll_area_with};
use crate::ui::{font, ico, icons as i, line, with_lh};

#[derive(Clone, Debug, PartialEq)]
pub struct Opt {
    pub label: String,
    /// A muted second line.
    pub detail: Option<String>,
    /// A short tag after the label ("Shown").
    pub tag: Option<String>,
    /// The version number drawn before the label.
    pub mark: Option<usize>,
}

/// The trigger: the summary and a chevron.
pub fn trigger(t: &Theme, key: &str, summary: &str, label: &str, open: bool, on_toggle: fn(&mut App)) -> El {
    crate::ui::css_border(row(), 1.0, t.c.input, t.radius_md())
        .key(key.to_string())
        .h(28.0)
        .pl(11.0)
        .pr(9.0)
        .gap(6.0)
        .items_center()
        .radius(t.radius_md())
        .fill(t.c.input_bg)
        // `.multi-select-trigger:hover { background: var(--accent) }`.
        .hover(crate::ui::hover_overlay(t.c.input_bg, t.c.accent))
        .role("combobox")
        .expanded(open)
        .label(format!("{label}: {summary}"))
        .cursor(Cursor::Pointer)
        .focusable(true)
        .on_press(on_toggle)
        .child(line(summary.to_string(), font(13.0, 400.0), t.c.foreground))
        .child(ico(&i::CHEVRONS_UP_DOWN, 14.0, t.c.muted_foreground))
}

/// `.version-mark`: a version's number in a dark pill.
pub fn mark(t: &Theme, n: usize) -> El {
    el().h(18.0)
        .min_w(18.0)
        .px(4.0)
        .radius(999.0)
        .fill(t.c.foreground)
        .center()
        .child(text(n.to_string()).font(crate::ui::tnum(with_lh(font(12.0, 600.0), 12.0))).color(t.c.background))
}

/// `.badge`, as the versions draw it (outlined, on the popover).
pub fn badge(t: &Theme, label: &str) -> El {
    crate::ui::css_border(row(), 1.0, t.c.border, 999.0)
        .h(20.0)
        .px(9.0)
        .items_center()
        .radius(999.0)
        .fill(t.c.popover)
        .child(text(label.to_string()).font(with_lh(font(12.0, 500.0), 17.4)).color(t.c.secondary_foreground))
}

/// The open list, anchored under the trigger's right edge, with a catcher
/// that closes it on any press outside.
pub fn list(t: &Theme, key: &str, options: &[Opt], values: &[usize], min_w: f32, on_toggle: fn(&mut App, usize), on_close: fn(&mut App)) -> El {
    let mut items = col().w_full();
    for (n, o) in options.iter().enumerate() {
        let selected = values.contains(&n);
        let locked = selected && values.len() <= 1;
        let mut box_ = crate::ui::css_border(el(), 1.0, if selected { t.c.primary } else { t.c.input }, 4.0).size(16.0, 16.0).mt(2.0).radius(4.0).center();
        if selected {
            box_ = box_.fill(t.c.primary).child(ico(&i::CHECK, 12.0, t.c.primary_foreground));
        }
        if locked {
            box_ = box_.opacity(0.5);
        }
        let mut label_row = row().gap(6.0).items_center().min_w(0.0);
        if let Some(m) = o.mark {
            label_row = label_row.child(mark(t, m));
        }
        label_row = label_row.child(line(o.label.clone(), font(14.0, 400.0), t.c.popover_foreground));
        if let Some(tag) = &o.tag {
            label_row = label_row.child(badge(t, tag));
        }
        let mut words = col().min_w(0.0).shrink().child(label_row);
        if let Some(d) = &o.detail {
            words = words.child(line(d.clone(), font(12.0, 400.0), t.c.muted_foreground));
        }
        let mut it = row()
            .key(format!("{key}-opt-{n}"))
            .w_full()
            .min_h(28.0)
            .px(6.0)
            .py(4.0)
            .gap(10.0)
            .items_start()
            .radius(t.radius_md())
            .role("option")
            .checked(selected)
            .label(o.label.clone())
            .hover(t.c.accent)
            .focus_highlight(t.c.accent)
            .focusable(true)
            .child(box_)
            .child(words);
        if !locked {
            it = it.cursor(Cursor::Pointer).on_press(move |app: &mut App| on_toggle(app, n));
        }
        items = items.child(it);
    }
    let panel = menu_panel(t, &format!("{key}-listbox"), None)
        .min_w(min_w)
        .max_w(360.0)
        .max_h(260.0)
        .role("listbox")
        .focus_group()
        .child(scroll_area_with(t, &format!("{key}-scroll"), items, false).shrink());
    el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .modal(false, on_close)
        .child(el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).on_press(on_close))
        .child(panel.anchored(key.to_string(), Side::Bottom, Align::End, 4.0))
}
