//! `QueuePopover.tsx` and `player/QueueButton.tsx` (`player-popovers.css`):
//! the playing track's band and the "Up next" list under it, shared with the
//! mini player's queue panel. A click on a row jumps playback there.

use rune::{Align, Color, Cursor, Cx, El, Side, col, el, row, text};

use super::adapters::{self, MenuContext};
use super::{Popover, close_btn, pop_box, pop_layer, position_pill};
use crate::api::{TrackListItem, media};
use crate::app::App;
use crate::format::display_text;
use crate::shell::player_bar::t_btn_icon;
use crate::theme::{Theme, color_mix};
use crate::ui::{cover_art, css_border_bottom, font, ico, icons as i, line, with_lh};

/// "12 / 40": where playback is in the queue, or None with nothing playing.
pub fn position(app: &App) -> Option<String> {
    app.player.current()?;
    let q = app.player.queue_progress();
    Some(format!("{} / {}", q.position, q.total))
}

/// The bar's queue button: the popover's toggle, or in the mini player the
/// queue panel's.
pub fn button(app: &App, t: &Theme) -> El {
    let mini = app.ui.player.mini.on;
    let open = if mini { app.ui.player.mini.requested == Some(super::mini::Panel::Queue) } else { app.ui.player.popover == Some(Popover::Queue) };
    let b = t_btn_icon(t, "queue", &i::LIST_MUSIC, crate::shell::player_bar::util_icon(app), open, false).label("Queue").help("Queue").expanded(open);
    if mini {
        b.on_press_tx(|app: &mut App, tx: &mut rune::Tx| super::mini::toggle_panel(app, tx, super::mini::Panel::Queue))
    } else {
        b.on_press(|app: &mut App| super::toggle_popover(app, Popover::Queue))
    }
}

/// The open queue popover, anchored above its button, 360 px wide and at
/// most 440 px (or the window less 120 px) tall.
pub fn popover(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    if app.ui.player.popover != Some(Popover::Queue) || app.ui.player.mini.on {
        return None;
    }
    let [_, window_h] = crate::shell::window_size(cx);
    let mut head = css_border_bottom(row(), 1.0, t.c.border)
        .min_h(36.0)
        .pl(12.0)
        .pr(4.0)
        .pt(3.0)
        .pb(4.0)
        .gap(6.0)
        .items_center()
        .child(super::centred(text("Queue").font(font(13.0, 600.0)).color(t.c.foreground), 18.85));
    if let Some(pos) = position(app) {
        head = head.child(position_pill(t, &pos));
    }
    head = head.child(el().grow(1.0)).child(close_btn(t, "queue-pop-close", "Close queue", true, super::close_popover));
    let mut pop = pop_box(t, "queue-pop", 360.0, false).max_h(440.0f32.min(window_h - 120.0)).label("Play queue").child(head);
    for part in list(app, t, cx, "queue-pop", true) {
        pop = pop.child(part);
    }
    Some(pop_layer("queue-pop", pop.anchored("queue", Side::Top, Align::End, 8.0)))
}

/// `QueueList`: the playing track's band, then the scrolling "Up next" list,
/// as two items of the caller's flex column. `close_on_jump` closes the
/// popover after a row click (the mini panel stays).
pub fn list(app: &App, t: &Theme, cx: &mut Cx<App>, scope: &str, close_on_jump: bool) -> Vec<El> {
    let p = &app.player;
    let current = p.current();
    // Only this app's own queue gets the row menu: a remote device's rows
    // aren't ours to act on.
    let menus = p.target_device().is_none();
    if current.is_none() && p.queue.is_empty() {
        let empty = col()
            .w_full()
            .px(12.0)
            .py(20.0)
            .gap(6.0)
            .items_center()
            .child(ico(&i::MUSIC, 20.0, t.c.muted_foreground))
            .child(text("Play something to start a queue.").font(font(13.0, 400.0)).color(t.c.muted_foreground).h(19.0));
        return vec![col().key(format!("{scope}-list")).px(4.0).pb(4.0).child(empty)];
    }
    let mut parts = Vec::new();
    let index = p.index.unwrap_or(0);
    if let Some(cur) = current {
        parts.push(now_playing_band(app, t, scope, cur, index, menus));
    }
    let upcoming = p.queue.get(index + 1..).unwrap_or(&[]);
    let mut rows = col().w_full().px(4.0).pb(4.0);
    if upcoming.is_empty() {
        rows = rows.child(
            el().px(8.0).pt(8.0).pb(4.0).child(el().h(17.4).child(text("Nothing queued after this.").font(font(12.0, 400.0)).color(t.c.muted_foreground))),
        );
    } else {
        let total = p.queue_progress().upcoming;
        rows = rows.child(
            el().px(8.0)
                .pt(8.0)
                .pb(4.0)
                .child(text(format!("Up next · {total}")).font(with_lh(font(12.0, 500.0), 16.0)).color(t.c.muted_foreground)),
        );
        for (n, track) in upcoming.iter().enumerate() {
            rows = rows.child(queue_row(app, t, scope, track, index + 1 + n, close_on_jump, menus));
        }
    }
    parts.push(super::auto_scroll(t, cx, &format!("{scope}-list"), rows).shrink().min_h(0.0));
    parts
}

/// The playing track: a full-width band tinted like the share card's
/// footer, with a larger cover, between hairlines.
fn now_playing_band(app: &App, t: &Theme, scope: &str, track: &TrackListItem, index: usize, menus: bool) -> El {
    let cover = media::track_cover(&track.id, track.album_id.as_deref(), track.cover_url.as_deref(), Some(96));
    let text_col = col()
        .grow(1.0)
        .min_w(0.0)
        .child(text("Now playing").font(with_lh(font(12.0, 500.0), 16.0)).color(t.c.muted_foreground))
        .child(line(display_text(Some(&track.title), ""), with_lh(font(14.0, 500.0), 18.0), t.c.foreground))
        .child(line(display_text(track.artist.as_deref(), "Unknown artist"), with_lh(font(12.0, 400.0), 16.0), t.c.muted_foreground));
    let mut band = css_border_bottom(row(), 1.0, t.c.border)
        .key(format!("{scope}-now"))
        .w_full()
        .px(12.0)
        .pt(8.0)
        .pb(9.0)
        .gap(12.0)
        .items_center()
        .fill(color_mix(t.c.muted, 0.5, Color::TRANSPARENT))
        .child(cover_art(t, &app.images, Some(&cover), &track.title, 48.0, 48.0, t.radius_md()))
        .child(text_col);
    if menus {
        let track = track.clone();
        band = band.on_secondary_press(move |app: &mut App, at, tx: &mut rune::Tx| {
            let queue = app.player.queue.clone();
            adapters::open_track_menu(app, tx, &track, at, MenuContext { queue: Some(queue), jump_to: Some(index) });
        });
    }
    band
}

/// An "Up next" row: a button that jumps playback to `index`.
fn queue_row(app: &App, t: &Theme, scope: &str, track: &TrackListItem, index: usize, close_on_jump: bool, menus: bool) -> El {
    let cover = media::track_cover(&track.id, track.album_id.as_deref(), track.cover_url.as_deref(), Some(64));
    let text_col = col()
        .grow(1.0)
        .min_w(0.0)
        .child(line(display_text(Some(&track.title), ""), with_lh(font(13.0, 500.0), 16.0), t.c.popover_foreground))
        .child(line(display_text(track.artist.as_deref(), "Unknown artist"), with_lh(font(12.0, 400.0), 16.0), t.c.muted_foreground));
    let mut r = row()
        .key(format!("{scope}-row-{index}"))
        .w_full()
        .px(8.0)
        .py(4.0)
        .gap(10.0)
        .items_center()
        .radius(t.radius_md())
        .role("button")
        .label(display_text(Some(&track.title), ""))
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover(t.c.accent)
        .focus_highlight(t.c.accent)
        .on_press(move |app: &mut App| {
            app.player.jump_to(index);
            if close_on_jump {
                super::close_popover(app);
            }
        })
        .child(cover_art(t, &app.images, Some(&cover), &track.title, 32.0, 32.0, t.radius_sm()))
        .child(text_col);
    if menus {
        let track = track.clone();
        r = r.on_secondary_press(move |app: &mut App, at, tx: &mut rune::Tx| {
            let queue = app.player.queue.clone();
            adapters::open_track_menu(app, tx, &track, at, MenuContext { queue: Some(queue), jump_to: Some(index) });
        });
    }
    r
}
