//! Pieces the admin sections share: `.surface`, `AdminSectionTitle` /
//! `AdminSectionIntro`, `Disclosure`, `.stat-link`, `.skeleton-text`, the
//! form fields, the auto-fit grids and the music-folder dropdown.

use rune::{Color, Cursor, El, Span, TextEdit, TextStyle, col, el, row, text};

use crate::api::admin::MusicRoot;
use crate::app::App;
use crate::theme::Theme;
use crate::ui::forms::SelectOption;
use crate::ui::tooltip::TipExt;
use crate::ui::{font, ico, icons as i, kit, motion};

use super::table::advance;

/// The line box CSS gives `style`: its line height in Chromium's layout
/// units (1/64 px), so 12 px × 1.45 is 17.39, not the 18 a text element
/// rounds up to. Boxes sized with it keep the browser's vertical rhythm.
pub fn css_lh(style: TextStyle) -> f32 {
    (style.line_height * 64.0).floor() / 64.0
}

/// One line of text in a box as tall as its CSS line box.
pub fn line_box(e: El, style: TextStyle) -> El {
    el().h(css_lh(style)).child(e)
}

/// How many lines `s` takes wrapped at `width`.
pub fn lines_of(s: &str, spans: &[Span], style: TextStyle, width: f32) -> usize {
    crate::ui::css_lines(s, spans, style, Some(width), rune::text::RichLayoutOptions::default())
}

/// A wrapping paragraph `width` wide, as tall as its CSS line boxes.
pub fn para(s: &str, spans: Vec<Span>, style: TextStyle, color: Color, width: f32) -> El {
    let lines = lines_of(s, &spans, style, width);
    col().w(width)
        .h(css_lh(style) * lines as f32)
        .child(text(s.to_string()).spans(spans).font(style).color(color).wrap().w(width))
}

/// `AdminSectionTitle`: the 12 px eyebrow, in its 17.39 px line box.
pub fn eyebrow(t: &Theme, s: &str) -> El {
    line_box(kit::eyebrow(t, s), font(12.0, 500.0))
}

pub use crate::ui::ch;
pub use crate::ui::kit::surface;

/// A muted 14 px paragraph `width` wide.
pub fn intro(t: &Theme, s: &str, spans: Vec<Span>, width: f32) -> El {
    para(s, spans, font(14.0, 400.0), t.c.muted_foreground, width)
}

/// `AdminSectionIntro`: the eyebrow title over a muted description at most
/// 72 ch wide.
pub fn section_intro(t: &Theme, title: &str, description: &str, width: f32) -> El {
    let w = width.min(ch(72.0, font(14.0, 400.0)));
    col().w_full().gap(6.0).child(eyebrow(t, title)).child(intro(t, description, Vec::new(), w))
}

/// Text with `code` runs (`<code>`) in the mono face.
pub fn with_code(s: &str, code: &[&str]) -> (String, Vec<Span>) {
    let mut spans = Vec::new();
    for c in code {
        if let Some(at) = s.find(c) {
            spans.push(Span { mono: true, ..Span::new(at, at + c.len()) });
        }
    }
    (s.to_string(), spans)
}

/// `Disclosure`: a ghost "› Label  N" toggle; the content goes under it,
/// 8 px down, while `open`.
pub fn disclosure(t: &Theme, key: &str, label: &str, count: Option<&str>, open: bool, toggle: impl Fn(&mut App) + 'static) -> El {
    let style = font(13.0, 500.0);
    let mut b = row()
        .key(key.to_string())
        .h(28.0)
        .ml(-10.0)
        .px(10.0)
        .gap(4.0)
        .items_center()
        .radius(t.radius_md().min(12.0))
        .role("button")
        .expanded(open)
        .label(label.to_string())
        .hover(t.c.ghost_hover)
        .press_scale(0.97)
        .cursor(Cursor::Pointer)
        .focusable(true)
        .on_press(toggle)
        .child(
            ico(&i::CHEVRON_RIGHT, 14.0, t.c.foreground)
                .rotate(if open { std::f32::consts::FRAC_PI_2 } else { 0.0 })
                .rotate_motion(motion::ease_out(150.0)),
        )
        .child(text(label.to_string()).font(style).color(t.c.foreground));
    if let Some(c) = count {
        b = b.child(text(c.to_string()).font(style).color(t.c.muted_foreground));
    }
    row().child(b)
}

/// `.stat-link`: inherited text with a dotted underline 4 px under it
/// (solid on hover), widened to at least 24 px without moving the text.
pub fn stat_link(key: &str, label: &str, style: TextStyle, color: Color, help: Option<&str>, on_press: impl Fn(&mut App, &mut rune::Tx) + 'static) -> El {
    let w = advance(label, style);
    // A `<button>` centres its text in the 24 px it's widened to.
    let box_w = (w + 12.0).max(24.0);
    let x = (box_w - w) / 2.0;
    // Chromium's dotted underline: square dots as thick as the line (2 px
    // at 18 px), a dot and a gap each that wide, 4 px under the baseline.
    let thick = (style.size / 9.0).round().max(1.0);
    let under = style.line_height / 2.0 + style.size * 0.36 + 2.75;
    let mut dots = row().absolute(x, under).w(w).h(thick).gap(thick).group_opacity(1.0, 0.0);
    let n = ((w + thick) / (thick * 2.0)).floor() as usize;
    for _ in 0..n {
        dots = dots.child(el().size(thick, thick).fill(color));
    }
    let solid = el().absolute(x, under).size(w, thick).fill(color).group_opacity(0.0, 1.0);
    let mut b = row()
        .key(key.to_string())
        .w(box_w)
        .mx(-6.0)
        .justify_center()
        .role("button")
        .label(label.to_string())
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover(Color::TRANSPARENT)
        .on_press_tx(on_press)
        .child(text(label.to_string()).font(style).color(color).w(w))
        .child(dots)
        .child(solid);
    if let Some(h) = help {
        b = b.tip(key, h);
    }
    b
}

/// `.skeleton-text`, `w` wide: a muted bar where a number will be.
pub fn skeleton(t: &Theme, w: f32, font_size: f32) -> El {
    el().w(w).h(font_size * 0.75).radius(t.radius_sm()).fill(t.c.muted).label("Measuring").role("img")
}

/// A `.input` text field bound to the edit `lens` reaches; Return runs
/// `submit` (the form's submit).
pub fn text_field(
    t: &Theme,
    key: &str,
    edit: &TextEdit,
    placeholder: &str,
    lens: impl for<'a> Fn(&'a mut App) -> &'a mut TextEdit + 'static,
    submit: impl Fn(&mut App) + 'static,
) -> El {
    crate::ui::input_with(t, key, edit, placeholder, move |e| {
        e.on_edit(lens).on_submit(move |app: &mut App, _tx: &mut rune::Tx| submit(app))
    })
}

/// `Field` with a 14 px medium label (`.field-label`, line-height 1).
pub fn field(t: &Theme, label: &str, control: El) -> El {
    crate::ui::forms::field(t, label, control, None, None)
}

/// `ErrorBanner`.
pub fn banner(t: &Theme, message: &str) -> El {
    kit::error_banner(t, message)
}

/// A 12 px muted note under a table, with an inline "Try again".
pub fn retry_note(t: &Theme, key: &str, message: &str, retry: fn(&mut App)) -> El {
    let style = font(12.0, 400.0);
    row()
        .flex_wrap()
        .items_center()
        .child(text(format!("{message} ")).font(style).color(t.c.muted_foreground).wrap())
        .child(stat_link(key, "Try again", style, t.c.muted_foreground, None, move |app, _| retry(app)))
}

/// `repeat(auto-fit, minmax(min, 1fr))` with `n` items: the columns' width.
pub fn fit_columns(width: f32, min: f32, gap: f32, n: usize) -> (usize, f32) {
    let tracks = (((width + gap) / (min + gap)).floor() as usize).max(1);
    let cols = tracks.min(n.max(1));
    (cols, (width - gap * (cols as f32 - 1.0)) / cols as f32)
}

/// A `repeat(auto-fit, minmax(min, 1fr))` grid of `items`, `gap` apart
/// both ways, each row's items on its bottom edge when `align_end`
/// (`align-items: end`).
pub fn auto_fit(items: Vec<El>, width: f32, min: f32, gap: f32, align_end: bool) -> El {
    let (cols, w) = fit_columns(width, min, gap, items.len());
    let line = || if align_end { row().gap(gap).items_end() } else { row().gap(gap) };
    let mut out = col().gap(gap);
    let mut current = line();
    for (n, item) in items.into_iter().enumerate() {
        if n > 0 && n % cols == 0 {
            out = out.child(current);
            current = line();
        }
        current = current.child(item.w(w));
    }
    out.child(current)
}

/// The music folders as dropdown options: "Primary - /music", "Label -
/// /path" ("Source" without a label). An option's value is what `value`
/// reads off its root (the pins pick a folder by path, auto-download by
/// id); missing folders are disabled, and paused ones too when
/// `need_enabled` (files under a disabled root can't be streamed).
pub fn root_options(roots: &[MusicRoot], value: impl Fn(&MusicRoot) -> String, need_enabled: bool) -> Vec<SelectOption> {
    roots
        .iter()
        .map(|r| {
            let label = if r.primary {
                format!("Primary - {}", r.path)
            } else {
                format!("{} - {}", if r.label.is_empty() { "Source" } else { &r.label }, r.path)
            };
            SelectOption { disabled: !r.exists || (need_enabled && !r.enabled), ..SelectOption::new(value(r), label) }
        })
        .collect()
}
