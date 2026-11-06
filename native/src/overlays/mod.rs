//! Dialogs, menus and toasts drawn above the shell (portaled in the web app).
//!
//! Each overlay keeps its state in `app.overlays.<name>` and opens through
//! its module's `open*` functions:
//! - [`settings::open`], [`settings::toggle`], [`settings::close`]
//! - [`palette::open`], [`palette::toggle`], [`palette::close`]
//! - [`upload::open`], [`upload::close`]
//! - [`confirm::ask`], [`confirm::ask_then`], [`confirm::ask_action`]
//! - [`share::open`] (a track id), [`share::open_track`]
//! - [`track_info::open`] (a track id)
//! - [`edit::open_track`], [`edit::open_album`], [`edit::open_move_to_album`]
//!
//! The update toast follows the desktop updater by itself.
pub mod confirm;
pub mod edit;
pub mod palette;
pub mod requests;
pub mod scenes;
pub mod settings;
pub mod share;
pub mod toast;
pub mod track_info;
pub mod track_menu;
pub mod upload;

use rune::{Cx, El};

use crate::app::App;
use crate::theme::Theme;

/// Work for the next `poll`, which has a `Tx`.
pub type Later = Box<dyn FnOnce(&mut App, &mut rune::Tx)>;

#[derive(Default)]
pub struct Overlays {
    /// Run on the next poll: what a request's answer needs a `Tx` for.
    pub later: Vec<Later>,
    pub settings: settings::State,
    pub palette: palette::State,
    pub upload: upload::State,
    pub confirm: confirm::State,
    pub track_menu: track_menu::State,
    pub track_info: track_info::State,
    pub share: share::State,
    pub edit: edit::State,
    pub toast: toast::State,
}

/// Every open overlay, in paint order (later draws above).
pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Vec<El> {
    [
        toast::view(app, t, cx),
        settings::view(app, t, cx),
        upload::view(app, t, cx),
        edit::view(app, t, cx),
        share::view(app, t, cx),
        track_info::view(app, t, cx),
        palette::view(app, t, cx),
        track_menu::view(app, t, cx),
        confirm::view(app, t, cx),
        crate::ui::forms::select_layer(app, t, cx),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// The window's size in points, as the shell lays it out.
pub fn window_size(cx: &mut Cx<App>) -> [f32; 2] {
    cx.layout_size("app").unwrap_or([1280.0, 820.0])
}

/// `errorMessage(err, fallback)`: the server's message, else the fallback
/// (a transport failure or an empty body).
pub fn error_message(e: &crate::api::ApiError, fallback: &str) -> String {
    if e.status == 0 || e.message.trim().is_empty() { fallback.to_string() } else { e.message.clone() }
}

/// Run `f` with a `Tx` on the next poll (a request's answer has none).
pub fn later(app: &mut App, f: impl FnOnce(&mut App, &mut rune::Tx) + 'static) {
    app.overlays.later.push(Box::new(f));
    app.waker.wake();
}

/// The app's poll: run what [`later`] queued. True when anything ran.
pub fn poll(app: &mut App, tx: &mut rune::Tx) -> bool {
    let queued = std::mem::take(&mut app.overlays.later);
    let any = !queued.is_empty();
    for f in queued {
        f(app, tx);
    }
    any
}
