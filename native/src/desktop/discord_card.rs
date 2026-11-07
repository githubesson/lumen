//! `electron/discord-card.ts`: how the Discord card reads. The presence
//! worker fills it in for each track, and Settings' preview uses the same
//! functions, so the preview shows what Discord will.

use serde_json::{Map, Value};

use crate::core::js::{self, slice_utf16};

/// What follows "Listening to" in Discord's member list (`statusName`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StatusName {
    /// The app's name.
    #[default]
    App,
    /// The card's first line.
    Details,
    /// The card's second line.
    State,
}

impl StatusName {
    fn parse(v: &Value) -> Option<StatusName> {
        match v.as_str()? {
            "app" => Some(StatusName::App),
            "details" => Some(StatusName::Details),
            "state" => Some(StatusName::State),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            StatusName::App => "app",
            StatusName::Details => "details",
            StatusName::State => "state",
        }
    }
}

/// `DiscordCardOptions`. Each line is a template where `{title}`, `{artist}`
/// and `{album}` fill in; an empty template hides its line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscordCard {
    /// First line, bold.
    pub details: String,
    /// Second line.
    pub state: String,
    /// Third line, also the cover's tooltip.
    pub large_text: String,
    pub status_name: StatusName,
    /// The album cover, or the Lumen logo when off.
    pub cover: bool,
    /// The play/pause badge on the cover.
    pub play_state: bool,
    /// Keep the card up while paused, or clear it until playback resumes.
    pub show_paused: bool,
}

impl Default for DiscordCard {
    /// `DEFAULT_DISCORD_CARD`.
    fn default() -> Self {
        DiscordCard {
            details: "{title}".into(),
            state: "{artist}".into(),
            large_text: "{album}".into(),
            status_name: StatusName::App,
            cover: true,
            play_state: true,
            show_paused: true,
        }
    }
}

/// Longest template kept; Discord cuts each line at 128 characters anyway.
const MAX_TEMPLATE: usize = 128;

impl DiscordCard {
    /// `normalizeDiscordCard`: read options from `raw` (a hand-edited config,
    /// or the options Settings changed), taking each field that's missing or
    /// malformed from `base`.
    pub fn normalize(raw: Option<&Value>, base: &DiscordCard) -> DiscordCard {
        let empty = Map::new();
        let value = raw.and_then(Value::as_object).unwrap_or(&empty);
        let text = |k: &str, fallback: &str| match value.get(k) {
            Some(Value::String(s)) => slice_utf16(s, MAX_TEMPLATE).to_string(),
            _ => fallback.to_string(),
        };
        let flag = |k: &str, fallback: bool| value.get(k).and_then(Value::as_bool).unwrap_or(fallback);
        DiscordCard {
            details: text("details", &base.details),
            state: text("state", &base.state),
            large_text: text("largeText", &base.large_text),
            status_name: value.get("statusName").and_then(StatusName::parse).unwrap_or(base.status_name),
            cover: flag("cover", base.cover),
            play_state: flag("playState", base.play_state),
            show_paused: flag("showPaused", base.show_paused),
        }
    }

    /// The card as config.json stores it (`discordCard`).
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "details": self.details,
            "state": self.state,
            "largeText": self.large_text,
            "statusName": self.status_name.as_str(),
            "cover": self.cover,
            "playState": self.play_state,
            "showPaused": self.show_paused,
        })
    }

    /// The card's three lines for a track; None hides a line.
    pub fn lines(&self, fields: &CardFields) -> CardLines {
        CardLines {
            details: fill_template(&self.details, fields),
            state: fill_template(&self.state, fields),
            large_text: fill_template(&self.large_text, fields),
        }
    }

    /// Discord's `status_display_type`: 0 shows the app's name, 1 the state, 2 the details.
    pub fn status_display_type(&self) -> u8 {
        match self.status_name {
            StatusName::State => 1,
            StatusName::Details => 2,
            StatusName::App => 0,
        }
    }
}

/// `DiscordCardFields`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CardFields {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CardLines {
    pub details: Option<String>,
    pub state: Option<String>,
    pub large_text: Option<String>,
}

/// `clampForDiscord`: Discord wants 2–128 characters per line. A single
/// character (one emoji included) is padded, and a cut never splits an
/// emoji's surrogate pair.
pub fn clamp_for_discord(value: Option<&str>, max: usize) -> Option<String> {
    let trimmed = js::trim(value?);
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() < 2 {
        return Some(format!("{trimmed} "));
    }
    Some(slice_utf16(trimmed, max).to_string())
}

/// Text between fields that only joins them, dropped along with a missing field.
fn is_joiner(s: &str) -> bool {
    s.chars().all(|c| js::is_space(c) || "-–—·•|,:/~+&".contains(c))
}

/// Splits `template` around `{title}`, `{artist}` and `{album}` (any case):
/// even indexes are text, odd ones tokens, as `template.split(TOKEN)`.
fn split_tokens(template: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut text_start = 0;
    let mut i = 0;
    let bytes = template.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'{' {
            let rest = &template[i + 1..];
            let token = ["title", "artist", "album"].into_iter().find(|name| {
                rest.len() > name.len()
                    && rest.is_char_boundary(name.len())
                    && rest[..name.len()].eq_ignore_ascii_case(name)
                    && rest.as_bytes()[name.len()] == b'}'
            });
            if let Some(name) = token {
                parts.push(template[text_start..i].to_string());
                let end = i + name.len() + 2;
                parts.push(template[i..end].to_string());
                i = end;
                text_start = end;
                continue;
            }
        }
        i += 1;
    }
    parts.push(template[text_start..].to_string());
    parts
}

/// `\(\s*\)` and `\[\s*\]` removed, then runs of whitespace made one space.
fn tidy(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut kept = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let close = match chars[i] {
            '(' => Some(')'),
            '[' => Some(']'),
            _ => None,
        };
        if let Some(close) = close {
            let mut j = i + 1;
            while j < chars.len() && js::is_space(chars[j]) {
                j += 1;
            }
            if j < chars.len() && chars[j] == close {
                i = j + 1;
                continue;
            }
        }
        kept.push(chars[i]);
        i += 1;
    }
    let mut out = String::with_capacity(kept.len());
    let mut in_space = false;
    for c in kept.chars() {
        if js::is_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `fillDiscordTemplate`: fill `{title}`, `{artist}` and `{album}` into a
/// line's template. A missing field takes the joiner beside it along
/// ("{artist} · {album}" with no album reads "beansclub"), and a line whose
/// fields are all missing is hidden.
pub fn fill_template(template: &str, fields: &CardFields) -> Option<String> {
    let mut parts = split_tokens(template);
    let mut tokens = 0;
    let mut filled = 0;
    let mut text_before = false;
    for i in 0..parts.len() {
        if i % 2 == 0 {
            if !is_joiner(&parts[i]) {
                text_before = true;
            }
            continue;
        }
        tokens += 1;
        let key = parts[i][1..parts[i].len() - 1].to_ascii_lowercase();
        let value = match key.as_str() {
            "title" => fields.title.as_deref(),
            "artist" => fields.artist.as_deref(),
            _ => fields.album.as_deref(),
        }
        .map(js::trim)
        .filter(|v| !v.is_empty());
        if let Some(value) = value {
            parts[i] = value.to_string();
            filled += 1;
            text_before = true;
            continue;
        }
        parts[i].clear();
        if text_before {
            if is_joiner(&parts[i - 1]) {
                parts[i - 1].clear();
            }
        } else if i + 1 < parts.len() && is_joiner(&parts[i + 1]) {
            parts[i + 1].clear();
        }
    }
    if tokens > 0 && filled == 0 {
        return None;
    }
    clamp_for_discord(Some(&tidy(&parts.concat())), 128)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn track() -> CardFields {
        CardFields {
            title: Some("look for me in heaven".into()),
            artist: Some("beansclub".into()),
            album: Some("NOTHING LEFT TO SAY".into()),
        }
    }

    fn fields(title: Option<&str>, artist: Option<&str>, album: Option<&str>) -> CardFields {
        CardFields { title: title.map(Into::into), artist: artist.map(Into::into), album: album.map(Into::into) }
    }

    #[test]
    fn fills_the_tracks_fields_into_a_line() {
        assert_eq!(fill_template("{title}", &track()).as_deref(), Some("look for me in heaven"));
        assert_eq!(fill_template("{artist} · {album}", &track()).as_deref(), Some("beansclub · NOTHING LEFT TO SAY"));
        assert_eq!(fill_template("by {ARTIST}", &track()).as_deref(), Some("by beansclub"));
        assert_eq!(fill_template("on repeat", &track()).as_deref(), Some("on repeat"));
    }

    #[test]
    fn drops_a_missing_field_with_the_joiner_beside_it() {
        let no_album = fields(Some("Song"), Some("Band"), None);
        assert_eq!(fill_template("{artist} · {album}", &no_album).as_deref(), Some("Band"));
        assert_eq!(fill_template("{album} — {artist}", &no_album).as_deref(), Some("Band"));
        assert_eq!(fill_template("{title} - {album} - {artist}", &no_album).as_deref(), Some("Song - Band"));
        assert_eq!(fill_template("{album} · {album} · {artist}", &no_album).as_deref(), Some("Band"));
        assert_eq!(fill_template("{title} ({album})", &no_album).as_deref(), Some("Song"));
    }

    #[test]
    fn hides_a_line_thats_empty_or_whose_fields_are_all_missing() {
        assert_eq!(fill_template("", &track()), None);
        assert_eq!(fill_template("   ", &track()), None);
        assert_eq!(fill_template("from {album}", &fields(Some("Song"), None, None)), None);
    }

    #[test]
    fn keeps_lines_within_discords_2_to_128_characters() {
        assert_eq!(fill_template("{title}", &fields(Some("x"), None, None)).as_deref(), Some("x "));
        assert_eq!(fill_template("{title}", &fields(Some("🎧"), None, None)).as_deref(), Some("🎧 "));
        let long = "a".repeat(200);
        assert_eq!(fill_template("{title}", &fields(Some(&long), None, None)).map(|s| s.len()), Some(128));
        // A cut never leaves half of an emoji.
        let cut = format!("{}🎧", "a".repeat(127));
        assert_eq!(fill_template("{title}", &fields(Some(&cut), None, None)), Some("a".repeat(127)));
    }

    #[test]
    fn reads_saved_options_falling_back_to_the_defaults_for_anything_malformed() {
        let d = DiscordCard::default();
        assert_eq!(DiscordCard::normalize(None, &d), d);
        let raw = json!({ "details": "", "statusName": "nope", "cover": "yes", "showPaused": false });
        assert_eq!(
            DiscordCard::normalize(Some(&raw), &d),
            DiscordCard { details: "".into(), show_paused: false, ..d.clone() }
        );
    }

    #[test]
    fn takes_options_settings_didnt_change_or_sent_malformed_from_the_saved_card() {
        let saved = DiscordCard { details: "{artist}".into(), cover: false, ..DiscordCard::default() };
        assert_eq!(
            DiscordCard::normalize(Some(&json!({ "state": "from {album}" })), &saved),
            DiscordCard { state: "from {album}".into(), ..saved.clone() }
        );
        assert_eq!(DiscordCard::normalize(Some(&json!({ "statusName": "nope", "playState": 0 })), &saved), saved);
        for (name, want) in [("app", StatusName::App), ("details", StatusName::Details), ("state", StatusName::State)] {
            let base = DiscordCard { status_name: StatusName::State, ..saved.clone() };
            assert_eq!(DiscordCard::normalize(Some(&json!({ "statusName": name })), &base).status_name, want);
        }
    }

    #[test]
    fn round_trips_through_config_json() {
        let card = DiscordCard { state: "".into(), status_name: StatusName::Details, play_state: false, ..DiscordCard::default() };
        assert_eq!(DiscordCard::normalize(Some(&card.to_json()), &DiscordCard::default()), card);
        assert_eq!(card.status_display_type(), 2);
    }
}
