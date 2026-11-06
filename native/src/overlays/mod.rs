//! Dialogs, menus and toasts drawn above the shell (portaled in the web app).
pub mod confirm;
pub mod edit;
pub mod palette;
pub mod settings;
pub mod share;
pub mod toast;
pub mod track_info;
pub mod track_menu;
pub mod upload;

use rune::{Cx, El};

use crate::app::App;
use crate::theme::Theme;

#[derive(Default)]
pub struct Overlays {
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
        crate::pages::home::layer(app, t, cx),
        crate::ui::forms::select_layer(app, t, cx),
    ]
    .into_iter()
    .flatten()
    .collect()
}
