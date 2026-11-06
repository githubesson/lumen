//! `ShareDialog.tsx and components/share/*`.

pub mod snippet;

use rune::{Cx, El};

use crate::app::App;
use crate::theme::Theme;

/// What this overlay keeps while open.
#[derive(Default)]
pub struct State {}

/// The overlay, or None while it's closed.
pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let _ = (app, t, cx);
    None
}
