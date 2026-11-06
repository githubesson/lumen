//! App-wide shortcuts (`lib/keybindings.tsx`): Ctrl+K palette, Ctrl+B
//! sidebar, space to play.
use rune::{Key, KeyEvent, Tx};

use crate::app::App;

pub fn on_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    let _ = tx;
    if ev.is_command('k') {
        crate::overlays::palette::toggle(app);
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
