//! `context/Confirm.tsx, ConfirmDialog.tsx (confirm.css)`.

use std::sync::Arc;

use rune::{Cx, El, Icon};

use crate::api::{ApiResult, Client};
use crate::app::App;
use crate::theme::Theme;

/// `ConfirmOptions.subject`: what the confirm acts on, shown as a card.
#[derive(Clone, Debug, PartialEq)]
pub struct Subject {
    pub cover: Option<String>,
    pub art_label: String,
    pub name: String,
    pub detail: String,
}

/// `ConfirmOptions` with its `action`, which runs (off the UI thread) from
/// the dialog, so the dialog shows its progress and error.
#[derive(Clone)]
pub struct Request {
    pub title: String,
    pub message: String,
    pub confirm_label: String,
    pub busy_label: String,
    pub subject: Option<Subject>,
    pub confirm_icon: Option<&'static Icon>,
    pub error_fallback: String,
    pub action: Arc<dyn Fn(&Client) -> ApiResult<()> + Send + Sync>,
}

/// What this overlay keeps while open.
#[derive(Default)]
pub struct State {
    pub request: Option<Request>,
}

/// `useConfirm()(options)`: ask, then run `action`.
// The dialog lands with the confirm port; this sets its state.
pub fn open(app: &mut App, request: Request) {
    app.overlays.confirm.request = Some(request);
}

/// The overlay, or None while it's closed.
pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let _ = (app, t, cx);
    None
}
