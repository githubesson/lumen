//! App-wide shortcuts: `lib/keybindings.tsx`'s registry as the app uses it.
//!
//! - Ctrl+K toggles the command palette, even from a field or over
//!   Settings (it hands over); Ctrl+B collapses the sidebar (`Shell.tsx`).
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
    app.ui.settings_open || app.ui.palette_open || app.ui.upload_open || app.ui.mobile_nav_open || app.select.is_some()
}

pub fn on_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    let m = ev.mods;
    // palette:toggle (allowInInput, whileModal).
    if ev.is_command('k') && !m.shift && !m.alt {
        app.ui.settings_open = false;
        app.ui.palette_open = !app.ui.palette_open;
        return true;
    }
    if modal_open(app) || app.me().is_none() {
        return false;
    }
    // sidebar:toggle is `ctrl+b` on every platform.
    if matches!(ev.key, Key::Command('b')) && m.ctrl && !m.shift && !m.alt {
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
        Key::Left => {
            let to = (p.position - 5.0).max(0.0);
            p.seek(to);
        }
        Key::Right => {
            let to = p.position + 5.0;
            p.seek(to);
        }
        Key::Up => {
            let v = p.volume + 0.05;
            p.set_volume(v);
        }
        Key::Down => {
            let v = p.volume - 0.05;
            p.set_volume(v);
        }
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
