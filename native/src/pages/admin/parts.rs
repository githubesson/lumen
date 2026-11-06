//! Pieces the admin sections share: `.surface`, `AdminSectionTitle` /
//! `AdminSectionIntro`, `Disclosure`, `.stat-link`, `.skeleton-text`, and the
//! form fields.

use rune::{Color, Cursor, El, Span, TextEdit, TextStyle, col, el, row, text};

use crate::app::App;
use crate::theme::Theme;
use crate::ui::{css_border, font, ico, icons as i, kit, motion, with_lh};

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
    let (_, h) = rune::text::measure(s, spans, style, Some(width));
    ((h / style.line_height).round() as usize).max(1)
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

/// `.surface`: the card panel, with `pad` inside its 1 px border.
pub fn surface(t: &Theme, pad: f32) -> El {
    css_border(col(), 1.0, t.c.border, t.radius_xl()).padding(pad + 1.0).radius(t.radius_xl()).fill(t.c.card)
}

/// `n` `ch` of `style` (`max-width: 70ch`).
pub fn ch(n: f32, style: TextStyle) -> f32 {
    advance("0", style) * n
}

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
        b = b.help(h.to_string());
    }
    b
}

/// `.skeleton-text`, `w` wide: a muted bar where a number will be.
pub fn skeleton(t: &Theme, w: f32, font_size: f32) -> El {
    el().w(w).h(font_size * 0.75).radius(t.radius_sm()).fill(t.c.muted).label("Measuring").role("img")
}

/// A `.input` text field bound to the edit `lens` reaches; Return runs
/// `submit` (the form's submit) when given.
pub fn text_field(
    t: &Theme,
    key: &str,
    edit: &TextEdit,
    placeholder: &str,
    lens: for<'a> fn(&'a mut App) -> &'a mut TextEdit,
    submit: Option<fn(&mut App)>,
) -> El {
    crate::ui::input_with(t, key, edit, placeholder, move |e| {
        let e = e.on_edit(lens);
        match submit {
            Some(f) => e.on_submit(move |app: &mut App, _tx: &mut rune::Tx| f(app)),
            None => e,
        }
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

/// The 14 px body line height text style with an explicit `lh`.
pub fn style_lh(size: f32, weight: f32, lh: f32) -> TextStyle {
    with_lh(font(size, weight), lh)
}
