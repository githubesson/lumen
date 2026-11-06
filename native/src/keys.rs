//! App-wide shortcuts: `lib/keybindings.tsx`'s registry as the app uses it.
//!
//! - Ctrl+K toggles the command palette, even from a field or over
//!   Settings (it hands over); Ctrl+B collapses the sidebar (`Shell.tsx`).
//! - Ctrl+F focuses an album, artist or playlist page's search.
//! - The player's keys (`context/Player.tsx`): Space play/pause, ←/→ seek
//!   5 s, ↑/↓ volume ±5%, N next, P previous, M mute, S shuffle, R repeat.
//!
//! Rune routes a key to the focused control first: a text field keeps
//! typed keys and a focused button takes Space and Return, which is what the
//! web registry's `isEditableTarget` and button checks do. While a dialog is
//! open only `whileModal` bindings (the palette's) run.

use rune::{Key, KeyEvent, Tx};

use crate::app::App;

/// Whether a modal overlay holds the keyboard (`useModalKeyScope`).
pub fn modal_open(app: &App) -> bool {
    app.ui.settings_open
        || app.ui.palette_open
        || app.ui.upload_open
        || app.ui.mobile_nav_open
        || app.select.is_some()
        || app.overlays.confirm.is_open()
}

pub fn on_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if crate::overlays::track_menu::on_key(app, ev, tx) {
        return true;
    }
    // An open Select's listbox takes the arrows, Return and Escape.
    if crate::ui::forms::on_key(app, ev) {
        return true;
    }
    crate::ui::tooltip::on_key(app, ev);
    if crate::ui::track_select::on_key(app, ev, tx) {
        return true;
    }
    let m = ev.mods;
    // palette:toggle (allowInInput, whileModal; it hands over from Settings).
    if ev.is_command('k') && !m.shift && !m.alt {
        crate::overlays::palette::toggle(app);
        return true;
    }
    // While Settings is open, Ctrl+F means its own search box.
    if ev.is_command('f') && crate::overlays::settings::is_open(app) {
        crate::overlays::settings::focus_search(app);
        return true;
    }
    if modal_open(app) || app.me().is_none() {
        return false;
    }
    if crate::shell::player::on_key(app, ev, tx) {
        return true;
    }
    if crate::pages::home::on_key(app, ev, tx) {
        return true;
    }
    // Ctrl+F on an album, artist or playlist page focuses its search, also
    // when nothing inside the page has focus (`useDetailTrackSearch`).
    if crate::pages::library::on_key(app, ev) || crate::pages::playlists::on_key(app, ev, tx) {
        return true;
    }
    // sidebar:toggle is `ctrl+b` on every platform.
    if matches!(ev.key, Key::Command('b')) && m.ctrl && !m.shift && !m.alt {
        tx.motion_curve(crate::ui::motion::shell(280.0));
        app.toggle_sidebar();
        return true;
    }
    // The player's bindings take no modifiers.
    if m.cmd || m.ctrl || m.alt || m.logo {
        return false;
    }
    let _ = tx;
    let p = &mut app.player;
    match &ev.key {
        Key::Text(t) if t == " " => p.toggle_play(),
        Key::Left => p.seek_by(-5.0),
        Key::Right => p.seek_by(5.0),
        Key::Up => p.change_volume(0.05),
        Key::Down => p.change_volume(-0.05),
        Key::Text(t) if !m.shift => match t.as_str() {
            "n" => p.next(),
            "p" => p.previous(),
            "m" => p.toggle_mute(),
            "s" => p.toggle_shuffle(),
            "r" => p.cycle_repeat(),
            _ => return false,
        },
        _ => return false,
    }
    true
}
