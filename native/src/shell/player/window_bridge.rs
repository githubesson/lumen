//! The mini player's window calls (`setMiniPlayerMode`,
//! `setMiniPlayerPanel`, `getMiniPlayerPanelAnchor` on the desktop bridge):
//! [`crate::desktop::window`], which pins the window's size, keeps it on its
//! screen, picks the anchor and puts the normal bounds back. Headless runs
//! have no native window; there the viewport is resized instead, so scripts
//! can drive mini mode.

use rune::Tx;

use super::mini::Anchor;
use crate::app::App;
use crate::desktop::window::{self, PanelAnchor};

/// The mini player window: 780×184, and 344 tall with a panel open.
pub const MINI_SIZE: (f32, f32) = (window::MINI_PLAYER_SIZE.0 as f32, window::MINI_PLAYER_SIZE.1 as f32);

fn anchor(a: PanelAnchor) -> Anchor {
    match a {
        PanelAnchor::Top => Anchor::Top,
        PanelAnchor::Bottom => Anchor::Bottom,
    }
}

fn headless() -> bool {
    rune::tooling::headless_run().is_some()
}

/// Enter or leave the mini player window. False when the window can't change.
pub fn set_mini_player(app: &mut App, tx: &mut Tx, on: bool) -> bool {
    if headless() {
        let size = if on { MINI_SIZE } else { app.ui.player.window.unwrap_or((1280.0, 820.0)) };
        tx.resize_window_instant(size);
        return true;
    }
    let result = window::set_mini_player(on);
    result.ok && result.mini_player == on
}

/// Which edge stays put when the window grows for a panel.
pub fn mini_player_panel_anchor(app: &App) -> Anchor {
    let _ = app;
    anchor(window::mini_player_panel_anchor())
}

/// Grow the mini window for a panel, or shrink it back. The edge that
/// stayed put, or None when the window can't change.
pub fn set_mini_player_panel(app: &mut App, tx: &mut Tx, open: bool) -> Option<Anchor> {
    let _ = app;
    if headless() {
        let size = if open { window::MINI_PLAYER_PANEL_SIZE } else { window::MINI_PLAYER_SIZE };
        tx.resize_window_instant((size.0 as f32, size.1 as f32));
        return Some(Anchor::Top);
    }
    let result = window::set_mini_player_panel(open);
    result.ok.then(|| anchor(result.anchor))
}
