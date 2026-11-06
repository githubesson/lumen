//! App-wide shortcuts (`lib/keybindings.tsx`): Ctrl+K palette, Ctrl+B
//! sidebar, space to play.
use rune::{Key, KeyEvent, Tx};

use crate::app::App;

pub fn on_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if crate::overlays::track_menu::on_key(app, ev, tx) {
        return true;
    }
    crate::ui::tooltip::on_key(app, ev);
    if crate::ui::track_select::on_key(app, ev, tx) {
        return true;
    }
    if ev.is_command('k') {
        app.ui.settings_open = false;
        app.ui.palette_open = !app.ui.palette_open;
        return true;
    }
    if ev.is_command('b') {
        app.toggle_sidebar();
        return true;
    }
    if let Key::Text(t) = &ev.key
        && t == " "
        && tx.focused().is_none()
    {
        app.player.toggle_play();
        return true;
    }
    false
}
