//! Dialogs, menus and toasts drawn above the shell (portaled in the web app).
//!
//! Each overlay keeps its state in `app.overlays.<name>` and opens through
//! its module's `open*` functions:
//! - [`settings::open`], [`settings::toggle`], [`settings::close`]
//! - [`palette::open`], [`palette::toggle`], [`palette::close`]
//! - [`upload::open`], [`upload::close`]
//! - [`confirm::ask`], [`confirm::ask_then`], [`confirm::ask_action`]
//! - [`share::open`] (a track id)
//! - [`track_info::open`] (a track id)
//! - [`edit::open_track`], [`edit::open_album`], [`edit::open_move_to_album`]
//!
//! The update toast follows the desktop updater by itself.
pub mod confirm;
pub mod edit;
pub mod palette;
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

/// The root's overlay layers, in paint order (later draws above): the
/// dialogs and menus, then what goes over them (portals, the open select's
/// listbox, tooltips). Each set sits in a group that is always there, and
/// the groups are plain elements. That matters because while any element
/// in the window is sticky, Rune paints a `modal` element above every later
/// sibling that isn't one; as root siblings, a dialog would cover a
/// select's listbox or a tooltip drawn after it. Grouped, each set paints in
/// tree order, as Rune's input already treats it (what follows a modal is
/// over it).
pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Vec<El> {
    let group = |key: &str, layers: Vec<El>| {
        layers.into_iter().fold(rune::el().key(key).pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)), |g, l| g.child(l))
    };
    vec![group("overlay-layers", dialogs(app, t, cx)), group("over-overlays", over(app, t, cx))]
}

/// What goes over every dialog: portaled layers and the open select's
/// listbox, then tooltips.
fn over(app: &App, t: &Theme, cx: &mut Cx<App>) -> Vec<El> {
    [crate::ui::forms::select_layer(app, t, cx), crate::ui::tooltip::view(app, t, cx)].into_iter().flatten().collect()
}

/// Every open dialog, menu and toast, in paint order.
fn dialogs(app: &App, t: &Theme, cx: &mut Cx<App>) -> Vec<El> {
    [
        toast::view(app, t, cx),
        settings::view(app, t, cx),
        upload::view(app, t, cx),
        edit::view(app, t, cx),
        share::view(app, t, cx),
        track_info::view(app, t, cx),
        track_info::picker_view(app, t, cx),
        palette::view(app, t, cx),
        track_menu::view(app, t, cx),
        confirm::view(app, t, cx),
        crate::pages::playlists::overlay(app, t, cx),
        crate::pages::home::layer(app, t, cx),
    ]
    .into_iter()
    .flatten()
    .collect()
}

pub use crate::shell::window_size;

pub use crate::api::error_message;

/// Run `f` with a `Tx` on the next poll (a request's answer has none).
pub fn later(app: &mut App, f: impl FnOnce(&mut App, &mut rune::Tx) + 'static) {
    app.overlays.later.push(Box::new(f));
    app.waker.wake();
}

/// The app's poll: run what [`later`] queued. True when anything ran.
pub fn poll(app: &mut App, tx: &mut rune::Tx) -> bool {
    toast::on_status(app);
    let previewing = share::poll(app, tx) | settings::discord::poll(app, tx);
    let queued = std::mem::take(&mut app.overlays.later);
    let any = !queued.is_empty();
    for f in queued {
        f(app, tx);
    }
    any || previewing
}
