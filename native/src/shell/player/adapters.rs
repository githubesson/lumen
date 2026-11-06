//! What the player's UI borrows from the shared components: the track
//! context menu (`useTrackContextMenu`), the favourites store
//! (`useFavorites`) and `PlayingBars`.

use rune::{El, PointerPress, Tx};

use crate::api::TrackListItem;
use crate::app::App;
use crate::theme::Theme;

/// What a row's context menu acts on besides its track (`bind(track, { queue, onPlay })`).
#[derive(Clone, Debug, Default)]
pub struct MenuContext {
    /// The list the row came from, for "Play" from it.
    pub queue: Option<Vec<TrackListItem>>,
    /// The row's place in the player's queue.
    pub jump_to: Option<usize>,
}

/// Open the track context menu for `track` at the pointer.
pub fn open_track_menu(app: &mut App, tx: &mut Tx, track: &TrackListItem, at: PointerPress, ctx: MenuContext) {
    let _ = tx;
    let menu = crate::overlays::track_menu::MenuContext { queue: ctx.queue.unwrap_or_default(), ..Default::default() };
    crate::overlays::track_menu::open(app, track.clone(), [at.x, at.y], menu);
}

/// Whether the track menu is open (it takes Escape first).
pub fn track_menu_open(app: &App) -> bool {
    app.overlays.track_menu.is_open()
}

/// `useFavorites().isFavorite`.
pub fn is_favorite(app: &App, id: &str) -> bool {
    app.pages.favorites_has(id)
}

/// `useFavorites().toggle`, popping the bar's heart as it turns on.
pub fn toggle_favorite(app: &mut App, id: &str) {
    if !app.pages.favorites_has(id) {
        app.ui.player.fav_pops += 1;
    }
    crate::pages::favorites::toggle(app, id);
}

/// `PlayingBars`.
pub fn playing_bars(t: &Theme, key: &str) -> El {
    crate::ui::track_row::playing_bars(t).key(key)
}
