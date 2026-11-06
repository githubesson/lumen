//! `Home.tsx` and `components/home/*` (`home.css`, `board.css`,
//! `cards.css`), at `/`.
//!
//! - [`kinds`], [`arrangement`], [`layout`], [`fill`], [`albums`]: the
//!   panel kinds, the saved arrangement (`tweaks.homeBoard`), the default
//!   and packed layouts, how panels fill their slots, Albums' list.
//! - [`grid`]: the board's CSS grid (placement and auto rows).
//! - [`requests`], [`logic`]: what Home loads, and the core helpers it uses
//!   (until the API port merges).

pub mod albums;
pub mod arrangement;
pub mod fill;
pub mod grid;
pub mod kinds;
pub mod layout;
pub mod logic;
pub mod requests;

use rune::{Cx, El};

use crate::app::App;
use crate::route::Location;
use crate::theme::Theme;

/// What this page keeps between visits.
#[derive(Default)]
pub struct State {}

/// Runs on each navigation to the page: start its requests.
pub fn enter(app: &mut App, loc: &Location) {
    let _ = (app, loc);
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let _ = cx;
    super::fallback(app, t)
}
