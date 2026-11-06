//! What the player's UI borrows from components other agents are building.
//! Each function stands in for the shared one until the merge swaps it in;
//! they're marked `TODO(components-merge)`.

use rune::{El, PointerPress, Tx, el, row};

use crate::api::TrackListItem;
use crate::app::App;
use crate::theme::Theme;

/// What a row's context menu acts on besides its track (`bind(track, { queue, onPlay })`).
#[derive(Clone, Debug, Default)]
pub struct MenuContext {
    /// The list the row came from, for "Play" from it.
    pub queue: Option<Vec<TrackListItem>>,
    /// The row's place in the player's queue: "Play" jumps there.
    pub jump_to: Option<usize>,
}

/// Open the track context menu for `track` at the pointer
/// (`useTrackContextMenu().bind`).
// TODO(components-merge): call `crate::overlays::track_menu::open(app, tx, track, at, ctx)`.
pub fn open_track_menu(app: &mut App, tx: &mut Tx, track: &TrackListItem, at: PointerPress, ctx: MenuContext) {
    let _ = (app, tx, track, at, ctx);
}

/// Whether the track menu is open (the queue leaves Escape and outside
/// clicks to it while it is).
// TODO(components-merge): read `app.overlays.track_menu`.
pub fn track_menu_open(app: &App) -> bool {
    let _ = app;
    false
}

/// `useFavorites().isFavorite`.
// TODO(components-merge): the app-wide favourites store (`core::favorites::Favorites`).
pub fn is_favorite(app: &App, id: &str) -> bool {
    app.pages.favorites_has(id)
}

/// `useFavorites().toggle`: flips at once, sends the request, and rolls back
/// if it fails. A second toggle while one is in flight is dropped.
// TODO(components-merge): the app-wide favourites store (`core::favorites::Favorites`).
pub fn toggle_favorite(app: &mut App, id: &str) {
    if app.ui.player.fav_pending.iter().any(|p| p == id) {
        return;
    }
    let Some(client) = app.client.clone() else { return };
    let favorite = !app.pages.favorites_has(id);
    let ids = crate::core::favorites::with_favorite_id(&app.pages.favorite_ids, id, favorite);
    app.pages.favorite_ids = ids;
    if favorite {
        app.ui.player.fav_pops += 1;
    }
    app.ui.player.fav_pending.push(id.to_string());
    let toggle = crate::core::favorites::Toggle { id: id.to_string(), favorite };
    let sent = toggle.clone();
    app.net.run(
        move || sent.send(&client),
        move |app, result| {
            app.ui.player.fav_pending.retain(|p| *p != toggle.id);
            if result.is_err() {
                app.pages.favorite_ids = crate::core::favorites::with_favorite_id(&app.pages.favorite_ids, &toggle.id, !toggle.favorite);
            }
        },
    );
}

/// `PlayingBars` (`.playing-bars`): three 2 px bars in a 14 px box, at the
/// heights the CSS holds when its dance is off.
// TODO(components-merge): the shared `PlayingBars` from `TrackRowCells` (with its dance).
pub fn playing_bars(t: &Theme, key: &str) -> El {
    const STILL: [f32; 3] = [0.4, 0.8, 0.6];
    let mut bars = row().key(key).size(14.0, 14.0).gap(2.0).items_end();
    for still in STILL {
        bars = bars.child(el().w(2.0).h(14.0 * still).radius(1.0).fill(t.c.foreground));
    }
    bars
}
