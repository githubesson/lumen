//! `CenteredCard.tsx` (`auth.css`): the brand mark, a title and an intro
//! over a form, in a 400 px card centred in a window-high scroller.

use rune::{Align, El, col, text};

use crate::theme::Theme;
use crate::ui::{brand_mark, css_border, css_text_h, font, with_lh};

/// The card's content width: 400 less 24 px of padding and a 1 px border a side.
pub const CARD_W: f32 = 350.0;

/// `.auth-wrap`'s content: `h` high at least (`100dvh`), 24 px of padding,
/// the card centred by its auto margins.
pub fn centered_card(t: &Theme, h: f32, title: &str, intro: Option<El>, body: El) -> El {
    let style = with_lh(font(24.0, 600.0), 34.8).tracking(-0.48);
    let mut heading = col().w_full().child(
        text(title)
            .font(style)
            .color(t.c.foreground)
            .wrap()
            .align(Align::Center)
            .w_full()
            .h(css_text_h(title, style, Some(CARD_W))),
    );
    if let Some(intro) = intro {
        heading = heading.child(intro.mt(6.0));
    }
    let header = col()
        .w_full()
        .items_center()
        .gap(12.0)
        .mb(24.0)
        .child(brand_mark(t, 38.0))
        .child(heading);
    let r = t.radius_xl();
    let card = css_border(col(), 1.0, t.c.border, r)
        .key("auth-card")
        .w_full()
        .max_w(400.0)
        .padding(25.0)
        .radius(r)
        .fill(t.c.card)
        .child(header)
        .child(col().w_full().child(body));
    col()
        .key("auth-wrap")
        .w_full()
        .min_h(h)
        .padding(24.0)
        .center()
        .fill(t.c.background)
        .child(card)
}

/// `Field` in the card, its hint or error boxed as CSS boxes it.
pub fn field(t: &Theme, label: &str, control: El, hint: Option<&str>, error: Option<&str>) -> El {
    crate::ui::forms::field_in(t, label, control, hint, error, Some(CARD_W))
}

/// `ErrorBanner` across the card.
pub fn error(t: &Theme, message: &str) -> El {
    crate::ui::kit::error_banner_in(t, message, Some(CARD_W))
}

/// `<p>` intro text: 14 px muted, centred.
pub fn intro(t: &Theme, s: &str) -> El {
    let style = font(14.0, 400.0);
    text(s)
        .font(style)
        .color(t.c.muted_foreground)
        .wrap()
        .align(Align::Center)
        .w_full()
        .h(css_text_h(s, style, Some(CARD_W)))
}

/// `text-center text-sm/5 text-(--muted-foreground)`.
pub fn note(t: &Theme, s: &str) -> El {
    let style = with_lh(font(14.0, 400.0), 20.0);
    text(s)
        .font(style)
        .color(t.c.muted_foreground)
        .wrap()
        .align(Align::Center)
        .w_full()
        .h(css_text_h(s, style, Some(CARD_W)))
}

/// A scroller holding a screen that is a window high at least (`height:
/// 100dvh; overflow-y: auto`).
pub fn page_scroller(t: &Theme, key: &str, content: El) -> El {
    crate::ui::kit::scroll_area_with(t, key, content, false)
        .w_full()
        .h_full()
}
