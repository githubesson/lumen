//! The frameless window's controls (`window:*` IPC in `electron/ipc.ts`).
use rune::Tx;

/// Maximize, or restore a maximized window.
pub fn toggle_maximize(tx: &mut Tx) {
    let _ = tx;
}
