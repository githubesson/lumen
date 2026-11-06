//! `player/PlaybackErrorPopover.tsx` and the error line of `NowPlaying.tsx`
//! (`np-error`, `np-error-btn` in `player.css`; `.error-pop` in
//! `player-popovers.css`): "Couldn't play this track." in place of the
//! artist, a button that opens what happened above the track, with a copy
//! of it for a bug report.

use rune::{Align, Cursor, Cx, El, Side, Tx, col, el, row, text};

use super::{Popover, close_btn, pop_box, pop_head, pop_layer};
use crate::app::App;
use crate::theme::Theme;
use crate::ui::{Btn, font, icons as i, line};

/// Where the error line's underline goes in a line box `lh` tall of
/// `size` px text (`text-underline-offset: 2px` under Geist's baseline).
pub fn underline_at(size: f32, lh: f32) -> f32 {
    lh / 2.0 + size * 0.404
}

/// The error line: a button that truncates itself, underlined on hover and
/// while its details show. In the mini player it toggles the error panel.
pub fn line_button(app: &App, t: &Theme, summary: &str, style: rune::TextStyle, underline_at: f32) -> El {
    let mini = app.ui.player.mini.on;
    let open = if mini { app.ui.player.mini.requested == Some(super::mini::Panel::Error) } else { app.ui.player.popover == Some(Popover::Error) };
    let mut underline = el().pin(Some(0.0), Some(underline_at), Some(0.0), None).h(1.0).fill(t.c.destructive).inert();
    underline = if open { underline } else { underline.group_opacity(0.0, 1.0) };
    let b = row()
        .key("np-error-btn")
        .min_w(0.0)
        .shrink()
        .radius(t.radius_sm())
        .role("button")
        .label(summary)
        .help(summary)
        .expanded(open)
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover(rune::Color::TRANSPARENT)
        .child(line(summary, style, t.c.destructive))
        .child(underline);
    if mini {
        b.on_press_tx(|app: &mut App, tx: &mut Tx| super::mini::toggle_panel(app, tx, super::mini::Panel::Error))
    } else {
        b.on_press(|app: &mut App| super::toggle_popover(app, Popover::Error))
    }
}

/// The open error popover: above the now-playing block, left-aligned with
/// it, at most 440 px wide, its details scrolling under the heading in a
/// short window.
pub fn popover(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    if app.ui.player.popover != Some(Popover::Error) || app.ui.player.mini.on {
        return None;
    }
    super::display::shown_error(app)?;
    let [window_w, _] = crate::shell::window_size(cx);
    let np_top = cx.layout("np").map_or(0.0, |r| r[1]);
    let w = 440.0f32.min(window_w - 24.0);
    let close = close_btn(t, "error-pop-close", "Close playback error", false, super::close_popover);
    let body = super::auto_scroll(t, cx, "error-pop-scroll", details(app, t, w - 2.0)).shrink().min_h(0.0);
    let pop = pop_box(t, "error-pop", w, true)
        .max_h((np_top - 20.0).max(120.0))
        .label("Playback error")
        .child(pop_head(t, "Playback error", None, close))
        .child(body);
    Some(pop_layer("error-pop", pop.anchored("np", Side::Top, Align::Start, 8.0)))
}

/// `PlaybackErrorDetails`: what happened to the current track, line by line
/// (a two-column grid: labels sized to the longest, values wrapping
/// anywhere), and the copy button. `w` is the width it lays out in.
pub fn details(app: &App, t: &Theme, w: f32) -> El {
    let p = &app.player;
    let Some(error) = super::display::shown_error(app) else { return col() };
    let lines = error.lines(p.current());
    let style = font(12.0, 400.0);
    let label_w = lines.iter().map(|l| rune::text::measure(l.label, &[], style, None).0).fold(0.0f32, f32::max);
    let value_w = (w - 28.0 - label_w - 14.0).max(0.0);
    let mut grid = col().w_full().gap(6.0);
    for (n, l) in lines.iter().enumerate() {
        let ink = if n == 0 { t.c.destructive } else { t.c.foreground };
        // Whole lines of the CSS line height (Rune rounds a text box up).
        let opts = rune::text::RichLayoutOptions::new().wrap_anywhere();
        let (_, h) = rune::text::measure_with(&l.value, &[], style, Some(value_w), opts);
        let h = (h / style.line_height).round().max(1.0) * style.line_height;
        grid = grid.child(
            row()
                .key(format!("error-line-{n}"))
                .gap(14.0)
                .items_start()
                .child(el().w(label_w).h(style.line_height).child(text(l.label).font(style).color(t.c.muted_foreground)))
                .child(text(l.value.clone()).font(style).color(ink).wrap_anywhere().selectable(true).w(value_w).h(h)),
        );
    }
    let copied = app.ui.player.copied;
    let copy = Btn::new("error-copy", if copied { "Copied" } else { "Copy details" })
        .small()
        .icon(if copied { &i::CHECK } else { &i::CLIPBOARD })
        .build(t)
        .on_press_tx(|app: &mut App, tx: &mut Tx| {
            if let Some(text) = app.player.error_text() {
                tx.copy(text);
                super::flash_copied(app);
            }
        });
    col().key("error-pop-body").w_full().px(14.0).pt(12.0).pb(14.0).gap(14.0).child(grid).child(row().w_full().justify_end().child(copy))
}
