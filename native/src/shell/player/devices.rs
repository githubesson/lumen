//! `PlaybackDevicePopover.tsx`, `player/DevicePickerButton.tsx` and
//! `RemoteControlIndicator.tsx` (`player-popovers.css`, `player.css`): this
//! device and every other online one, picked to play there; the bar's
//! button with its live dot; the "controlled from another device" notice.

use rune::{Align, Cursor, El, Icon, Side, col, el, row, text};

use super::{Popover, close_btn, pop_box, pop_head, pop_layer, status_pill};
use crate::app::App;
use crate::ui::tooltip::TipExt;
use crate::format::display_text;
use crate::player::{DeviceKind, playback_device_button_label, playback_device_kind, playback_device_status};
use crate::shell::player_bar::t_btn_with;
use crate::theme::Theme;
use crate::ui::{css_border, font, ico, icons as i, line, with_lh};
use crate::ui::ShadowMd;

/// The bar's device button (`.device-picker-btn`): lit while another device
/// is controlled or the picker is open, pulsing while a command is on its
/// way, red after one failed; a live dot while controlling another device.
pub fn button(app: &App, t: &Theme) -> El {
    let p = &app.player;
    let mini = app.ui.player.mini.on;
    let open = if mini { app.ui.player.mini.requested == Some(super::mini::Panel::Devices) } else { app.ui.player.popover == Some(Popover::Devices) };
    let target = p.target_device();
    let error = p.command_error();
    let pending = p.command_pending();
    let lit = target.is_some() || open;
    let ink = if error.is_some() { t.c.destructive } else if lit { t.c.foreground } else { t.c.muted_foreground };
    let mut glyph = ico(&i::MONITOR, crate::shell::player_bar::util_icon(app), ink);
    if error.is_none() {
        glyph = glyph.group_color(t.c.foreground);
    }
    if pending {
        // `device-command-pulse`: 900 ms from 50% to full and back.
        glyph = glyph.looping(rune::LoopSpec::cycle(rune::Cycle {
            period: 1.8,
            phase: 0.0,
            stops: &[(0.0, 0.5), (0.5, 1.0), (1.0, 0.5)],
            still: 0.75,
            fps: 30.0,
        }));
    }
    let mut b = t_btn_with(t, "devices", glyph, lit, false);
    if target.is_some() {
        let dot = if error.is_some() { t.c.destructive } else { t.c.success };
        b = b.child(el().pin(None, None, Some(4.0), Some(4.0)).size(6.0, 6.0).radius(999.0).fill(dot).inert());
    }
    let help = match (&error, target) {
        (Some(e), _) => e.clone(),
        (None, Some(d)) => format!("Controlling {}", d.device_name),
        (None, None) => playback_device_button_label(None),
    };
    b = b.label(playback_device_button_label(target)).tip("devices", &help).expanded(open);
    if mini {
        b.on_press_tx(|app: &mut App, tx: &mut rune::Tx| super::mini::toggle_panel(app, tx, super::mini::Panel::Devices))
    } else {
        b.on_press(|app: &mut App| super::toggle_popover(app, Popover::Devices))
    }
}

/// The open device popover, 300 px wide above its button.
pub fn popover(app: &App, t: &Theme) -> Option<El> {
    if app.ui.player.popover != Some(Popover::Devices) || app.ui.player.mini.on {
        return None;
    }
    let close = close_btn(t, "device-pop-close", "Close device picker", false, super::close_popover);
    let mut pop = pop_box(t, "device-pop", 300.0, false)
        .label("Playback device")
        .child(pop_head(t, "Play on", Some(status_pill(app, t)), close));
    for part in list(app, t, "device-pop", true, 298.0) {
        pop = pop.child(part);
    }
    Some(pop_layer("device-pop", pop.anchored("devices", Side::Top, Align::End, 8.0)))
}

/// `DeviceList`: this device and every other online one, and the last
/// command's failure. Shared with the mini player's device panel.
/// `inner_w` is the width of what holds the list (the popover inside its
/// border, or the mini panel's card).
pub fn list(app: &App, t: &Theme, scope: &str, close_on_select: bool, inner_w: f32) -> Vec<El> {
    let p = &app.player;
    let target = p.target_device();
    let local_playing = target.is_none() && p.playing && p.current().is_some();
    let meta = if local_playing {
        format!("Playing · {}", display_text(p.current().map(|c| c.title.as_str()), ""))
    } else if target.is_some() {
        "Play here instead".into()
    } else {
        "Listening here".into()
    };
    let mut body = col().key(format!("{scope}-body")).w_full().padding(6.0);
    body = body.child(device_row(t, &format!("{scope}-local"), &i::LAPTOP, "This device", &meta, target.is_none(), local_playing, false, close_on_select, None));
    body = body.child(el().px(8.0).pt(10.0).pb(4.0).child(el().h(17.4).child(text("Other devices").font(font(12.0, 500.0)).color(t.c.muted_foreground))));
    let remote = p.remote_devices();
    if remote.is_empty() {
        body = body.child(empty_card(t, inner_w));
    }
    for d in &remote {
        let (status_label, status_playing) = playback_device_status(d);
        let glyph = device_icon(playback_device_kind(&d.device_name));
        let active = target.is_some_and(|t| t.device_id == d.device_id);
        body = body.child(device_row(
            t,
            &format!("{scope}-device-{}", d.device_id),
            glyph,
            &d.device_name,
            &status_label,
            active,
            status_playing,
            true,
            close_on_select,
            Some(d.device_id.clone()),
        ));
    }
    let mut parts = vec![body];
    if let Some(e) = p.command_error() {
        parts.push(
            crate::ui::css_border_top(el(), 1.0, t.c.border).w_full()
                .px(12.0)
                .pt(9.0)
                .pb(8.0)
                .fill(t.c.destructive_soft)
                .role("status")
                .child(text(e).font(font(12.0, 400.0)).color(t.c.destructive).wrap()),
        );
    }
    parts
}

fn device_icon(kind: DeviceKind) -> &'static Icon {
    match kind {
        DeviceKind::Tablet => &i::TABLET,
        DeviceKind::Phone => &i::SMARTPHONE,
        DeviceKind::Web => &i::APP_WINDOW,
        DeviceKind::Desktop => &i::MONITOR,
    }
}

const HINT: &str = "Open Lumen on your phone or another computer.";

/// Wrapped text at its CSS height (whole lines), wrapping at `w`.
fn css_wrapped(e: El, s: &str, style: rune::TextStyle, w: f32) -> El {
    e.h(crate::ui::css_text_h(s, style, Some(w)))
}

/// `.device-pop-empty`: a dashed card saying no other device is online.
fn empty_card(t: &Theme, inner_w: f32) -> El {
    let tile = el().size(32.0, 32.0).radius(t.radius_md()).fill(t.c.muted).center().child(ico(&i::MONITOR_SMARTPHONE, 16.0, t.c.muted_foreground));
    let copy = col()
        .grow(1.0)
        .min_w(0.0)
        .gap(2.0)
        .child(el().h(18.85).child(text("No other devices online").font(font(13.0, 500.0)).color(t.c.popover_foreground)))
        .child(css_wrapped(
            text(HINT).font(with_lh(font(12.0, 400.0), 16.8)).color(t.c.muted_foreground).wrap(),
            HINT,
            with_lh(font(12.0, 400.0), 16.8),
            // Less the body's padding, the card's margins, padding and
            // border, its tile and gap.
            inner_w - 12.0 - 4.0 - 26.0 - 32.0 - 12.0,
        ));
    row()
        .mx(2.0)
        .mt(2.0)
        .mb(4.0)
        .padding(13.0)
        .gap(12.0)
        .items_center()
        .child(
            el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .radius(t.radius_md())
                .border(1.0, t.c.border)
                .border_dash(3.0, 3.0)
                .inert(),
        )
        .child(tile)
        .child(copy)
}

#[allow(clippy::too_many_arguments)]
fn device_row(
    t: &Theme,
    key: &str,
    glyph: &'static Icon,
    name: &str,
    meta: &str,
    active: bool,
    playing: bool,
    online: bool,
    close_on_select: bool,
    device_id: Option<String>,
) -> El {
    // The device playing right now gets the solid tile.
    let mut tile = if active {
        el().size(32.0, 32.0).radius(t.radius_md()).fill(t.c.foreground).center().child(ico(glyph, 16.0, t.c.background))
    } else {
        css_border(el(), 1.0, t.c.border, t.radius_md()).size(32.0, 32.0).radius(t.radius_md()).fill(t.c.background).center().child(ico(glyph, 16.0, t.c.foreground))
    };
    if online {
        tile = tile.child(el().pin(None, None, Some(-2.0), Some(-2.0)).size(8.0, 8.0).radius(999.0).fill(t.c.success).border(2.0, t.c.popover).inert());
    }
    let copy = col()
        .grow(1.0)
        .min_w(0.0)
        .gap(3.0)
        .child(el().h(20.3).min_w(0.0).child(line(name, font(14.0, 500.0), t.c.popover_foreground)))
        .child(el().h(17.4).min_w(0.0).child(line(meta, font(12.0, 400.0), t.c.muted_foreground)));
    let mut r = row()
        .key(key)
        .w_full()
        .min_h(48.0)
        .px(8.0)
        .py(6.0)
        .gap(10.0)
        .items_center()
        .radius(t.radius_md())
        .role("button")
        .label(name)
        .checked(active)
        .cursor(Cursor::Pointer)
        .focusable(true)
        .focus_highlight(t.c.accent)
        .child(tile)
        .child(copy);
    r = if active { r.fill(t.c.accent).hover_group() } else { r.hover(t.c.accent) };
    if playing {
        r = r.child(el().mr(1.0).child(super::adapters::playing_bars(t, &format!("{key}-bars"))));
    } else if active {
        r = r.child(ico(&i::CHECK, 14.0, t.c.foreground));
    }
    r.on_press(move |app: &mut App| {
        app.player.select_target(device_id.as_deref());
        if close_on_select {
            super::close_popover(app);
        }
    })
}

/// `RemoteControlIndicator`: "Controlled from another device" over the top
/// edge of the bar for 6 s after another device's command lands here.
pub fn remote_indicator(app: &App, t: &Theme, mini: bool) -> Option<El> {
    app.player.remote_control_event()?;
    let pill = css_border(row(), 1.0, t.c.border, t.radius_lg())
        .shadow_md(t)
        .key("remote-control-indicator")
        .h(28.0)
        .px(11.0)
        .gap(6.0)
        .items_center()
        .radius(t.radius_lg())
        .fill(t.c.popover)
        .role("status")
        .inert()
        .child(ico(&i::SMARTPHONE, 14.0, t.c.muted_foreground))
        .child(text("Controlled from another device").font(with_lh(font(12.0, 500.0), 12.0)).color(t.c.popover_foreground));
    // Centred on the shell's top edge (`translate(-50%, -50%)`); in the mini
    // player 8 px inside the top.
    let (top, enter) = if mini { (8.0, rune::Transition::none()) } else { (-14.0, rune::Transition::scale(0.96).combined(rune::Transition::offset(0.0, 1.7))) };
    Some(row().pin(Some(0.0), Some(top), Some(0.0), None).justify_center().inert().child(pill.transition(enter)))
}

