//! The mini player's window calls (`setMiniPlayerMode`,
//! `setMiniPlayerPanel`, `getMiniPlayerPanelAnchor` on the desktop bridge).
//! Stand-ins that resize the window from the view until the desktop layer's
//! own functions land.
// TODO(desktop-merge): call `crate::desktop::window::{set_mini_player,
// set_mini_player_panel, mini_player_panel_anchor}` instead (they also keep
// the window on screen, pick the anchor and restore the normal bounds).

use rune::Tx;

use super::mini::Anchor;
use crate::app::App;

/// The mini player window: 780×184, and 344 tall with a panel open.
pub const MINI_SIZE: (f32, f32) = (780.0, 184.0);
pub const MINI_PANEL_HEIGHT: f32 = 344.0;

/// Enter or leave the mini player window. Leaving goes back to the size the
/// window had. False when the window can't change.
pub fn set_mini_player(app: &mut App, tx: &mut Tx, on: bool) -> bool {
    let size = if on { MINI_SIZE } else { app.ui.player.window.unwrap_or((1280.0, 820.0)) };
    tx.resize_window_instant(size);
    true
}

/// Which edge stays put when the window grows for a panel: the top, unless
/// the window sits too low on its screen to grow down.
pub fn mini_player_panel_anchor(app: &App) -> Anchor {
    let _ = app;
    Anchor::Top
}

/// Grow the mini window for a panel, or shrink it back. The edge that
/// stayed put, or None when the window can't change.
pub fn set_mini_player_panel(app: &mut App, tx: &mut Tx, open: bool) -> Option<Anchor> {
    let h = if open { MINI_PANEL_HEIGHT } else { MINI_SIZE.1 };
    tx.resize_window_instant((MINI_SIZE.0, h));
    Some(mini_player_panel_anchor(app))
}
