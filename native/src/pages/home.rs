//! `Home.tsx and components/home/* (home.css, board.css)`, at `/`.

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
