//! Chromium's own form controls, as the web app's CSS leaves them: the 13 px
//! `<input type="radio">` and `<input type="checkbox">` in
//! `accent-color: var(--primary)` (`color-scheme` light or dark), and
//! `RadioCardOption.tsx` around the radio.

use rune::{Color, Cursor, El, col, el, row, text};

use crate::app::App;
use crate::theme::{Theme, color_mix};
use crate::ui::{css_border, font, ico, icons as i};

/// Chromium's control ring, light scheme.
const RING_LIGHT: &str = "#767676";
/// Chromium's control ring, dark scheme.
const RING_DARK: &str = "#858585";
/// Chromium's control field in the dark scheme (the light one's is white),
/// also the mark it draws on a light accent.
const FIELD_DARK: &str = "#3b3b3b";

/// The ring round an unchecked control.
pub fn ring(t: &Theme) -> Color {
    rune::color::hex(if t.dark() { RING_DARK } else { RING_LIGHT }).unwrap()
}

/// The field inside a control's ring.
pub fn field(t: &Theme) -> Color {
    if t.dark() { rune::color::hex(FIELD_DARK).unwrap() } else { Color::WHITE }
}

/// `<input type="radio">`: a 13 px ring on the field colour; checked, the
/// ring and a dot in the accent with a field-coloured gap between them.
pub fn radio(t: &Theme, checked: bool) -> El {
    if checked {
        el().size(13.0, 13.0).radius(6.5).fill(t.c.primary).center().child(
            el().size(11.0, 11.0).radius(5.5).fill(field(t)).center().child(el().size(8.6, 8.6).radius(4.3).fill(t.c.primary)),
        )
    } else {
        css_border(el().size(13.0, 13.0).radius(6.5).fill(field(t)), 1.0, ring(t), 6.5)
    }
}

/// `<input type="checkbox">` at its 13 px: the accent square with the
/// check mark, or the ring on the field colour.
pub fn checkbox(t: &Theme, checked: bool) -> El {
    if checked {
        return el().size(13.0, 13.0).radius(2.0).fill(t.c.primary).center().child(ico(&i::CHECK, 11.0, t.c.primary_foreground));
    }
    css_border(el().size(13.0, 13.0).radius(2.0).fill(field(t)), 1.0, ring(t), 2.0)
}

/// `RadioCardOption`: a bordered card with a radio, its label and a line
/// under it; the checked one is outlined in the primary colour over a faint
/// tint of it.
pub fn radio_card(t: &Theme, key: &str, checked: bool, label: &str, description: &str, on_pick: impl Fn(&mut App) + 'static) -> El {
    let r = t.radius_lg();
    let mut card = css_border(row(), 1.0, if checked { t.c.primary } else { t.c.border }, r)
        .key(key.to_string())
        .w_full()
        .padding(13.0)
        .gap(12.0)
        .items_start()
        .radius(r)
        .role("radio")
        .checked(checked)
        .label(label.to_string())
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover(t.c.foreground.alpha(0.08))
        .on_press(on_pick);
    if checked {
        card = card.fill(color_mix(t.c.primary, 0.05, Color::TRANSPARENT));
    }
    let description = text(description).font(font(12.0, 400.0)).color(t.c.muted_foreground).wrap();
    card.child(radio(t, checked).mt(2.0)).child(
        col()
            .grow(1.0)
            .min_w(0.0)
            .child(text(label).font(font(14.0, 500.0)).color(t.c.foreground).h(20.3))
            .child(crate::ui::snug_lines(&format!("{key}-desc"), description, 17.4).mt(2.0)),
    )
}
