//! `electron/discord-card.ts` as Settings edits and previews it: the
//! desktop side's card ([`crate::desktop::discord_card`], which presence
//! sends to Discord), under the names the preview uses.

pub use crate::desktop::discord_card::{CardFields as Fields, DiscordCard, StatusName};

/// Longest template kept; Discord cuts each line at 128 characters anyway.
pub const MAX_TEMPLATE: usize = 128;

/// The card's three lines for `fields` (`discordCardLines`), as Discord will show them.
pub fn lines(card: &DiscordCard, fields: &Fields) -> [Option<String>; 3] {
    let l = card.lines(fields);
    [l.details, l.state, l.large_text]
}

/// The status name a Select value picks.
pub fn status_name(v: &str) -> StatusName {
    match v {
        "details" => StatusName::Details,
        "state" => StatusName::State,
        _ => StatusName::App,
    }
}
