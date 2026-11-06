//! `electron/discord-card.ts`: how the Discord card reads, for the Settings
//! preview (and the presence the desktop side sends).
// TODO(desktop-merge): the desktop side's presence needs the same functions;
// keep one copy (here or in `crate::desktop`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `DiscordCardOptions`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordCard {
    /// First line, bold.
    pub details: String,
    /// Second line.
    pub state: String,
    /// Third line, also the cover's tooltip.
    pub large_text: String,
    /// "app", "details" or "state": what follows "Listening to".
    pub status_name: String,
    pub cover: bool,
    pub play_state: bool,
    pub show_paused: bool,
}

impl Default for DiscordCard {
    /// `DEFAULT_DISCORD_CARD`.
    fn default() -> Self {
        DiscordCard {
            details: "{title}".into(),
            state: "{artist}".into(),
            large_text: "{album}".into(),
            status_name: "app".into(),
            cover: true,
            play_state: true,
            show_paused: true,
        }
    }
}

/// Longest template kept; Discord cuts each line at 128 characters anyway.
pub const MAX_TEMPLATE: usize = 128;

impl DiscordCard {
    /// `normalizeDiscordCard`: each missing or malformed field from the default.
    pub fn from_value(raw: Option<&Value>) -> DiscordCard {
        let d = DiscordCard::default();
        let Some(Value::Object(m)) = raw else { return d };
        let text = |k: &str, fallback: &str| match m.get(k) {
            Some(Value::String(s)) => s.chars().take(MAX_TEMPLATE).collect(),
            _ => fallback.to_string(),
        };
        let flag = |k: &str, fallback: bool| m.get(k).and_then(Value::as_bool).unwrap_or(fallback);
        let status = match m.get("statusName").and_then(Value::as_str) {
            Some(s @ ("app" | "details" | "state")) => s.to_string(),
            _ => d.status_name.clone(),
        };
        DiscordCard {
            details: text("details", &d.details),
            state: text("state", &d.state),
            large_text: text("largeText", &d.large_text),
            status_name: status,
            cover: flag("cover", d.cover),
            play_state: flag("playState", d.play_state),
            show_paused: flag("showPaused", d.show_paused),
        }
    }
}

/// `DiscordCardFields`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fields {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

/// `clampForDiscord`: 2–128 characters, a lone character padded.
pub fn clamp_for_discord(value: Option<&str>, max: usize) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() < 2 {
        return Some(format!("{trimmed} "));
    }
    // JS slices UTF-16 units and drops a split surrogate; whole chars never split.
    let mut out = String::new();
    let mut units = 0;
    for c in trimmed.chars() {
        let n = c.len_utf16();
        if units + n > max {
            break;
        }
        units += n;
        out.push(c);
    }
    Some(out)
}

fn is_joiner(s: &str) -> bool {
    s.chars().all(|c| c.is_whitespace() || "-–—·•|,:/~+&".contains(c))
}

/// Split around `{title}`, `{artist}` and `{album}` (any case): odd indexes
/// are the tokens' field names, even ones the text around them.
fn split_tokens(template: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut rest = template;
    let lower = |s: &str| s.to_ascii_lowercase();
    'outer: loop {
        let l = lower(rest);
        let mut best: Option<(usize, &str)> = None;
        for name in ["title", "artist", "album"] {
            let tok = format!("{{{name}}}");
            if let Some(i) = l.find(&tok)
                && best.is_none_or(|(b, _)| i < b)
            {
                best = Some((i, name));
            }
        }
        match best {
            Some((i, name)) => {
                parts.push(rest[..i].to_string());
                parts.push(name.to_string());
                rest = &rest[i + name.len() + 2..];
            }
            None => {
                parts.push(rest.to_string());
                break 'outer;
            }
        }
    }
    parts
}

/// `fillDiscordTemplate`: fill the fields in; a missing field takes the
/// joiner beside it along, and a line whose fields are all missing is hidden.
pub fn fill_template(template: &str, fields: &Fields) -> Option<String> {
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
        let value = match parts[i].as_str() {
            "title" => fields.title.as_deref(),
            "artist" => fields.artist.as_deref(),
            _ => fields.album.as_deref(),
        }
        .map(str::trim)
        .filter(|v| !v.is_empty());
        if let Some(v) = value {
            parts[i] = v.to_string();
            filled += 1;
            text_before = true;
            continue;
        }
        parts[i] = String::new();
        if text_before {
            if is_joiner(&parts[i - 1]) {
                parts[i - 1] = String::new();
            }
        } else if i + 1 < parts.len() && is_joiner(&parts[i + 1]) {
            parts[i + 1] = String::new();
        }
    }
    if tokens > 0 && filled == 0 {
        return None;
    }
    let joined = parts.concat();
    // Drop emptied brackets, then collapse whitespace.
    let mut no_brackets = String::new();
    let chars: Vec<char> = joined.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '(' || c == '[' {
            let close = if c == '(' { ')' } else { ']' };
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && chars[j] == close {
                i = j + 1;
                continue;
            }
        }
        no_brackets.push(c);
        i += 1;
    }
    let mut line = String::new();
    let mut space = false;
    for c in no_brackets.chars() {
        if c.is_whitespace() {
            if !space {
                line.push(' ');
            }
            space = true;
        } else {
            line.push(c);
            space = false;
        }
    }
    clamp_for_discord(Some(&line), 128)
}

/// `discordCardLines`: the three lines for a track; None hides a line.
pub fn lines(card: &DiscordCard, fields: &Fields) -> [Option<String>; 3] {
    [fill_template(&card.details, fields), fill_template(&card.state, fields), fill_template(&card.large_text, fields)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(title: &str, artist: &str, album: &str) -> Fields {
        let o = |s: &str| (!s.is_empty()).then(|| s.to_string());
        Fields { title: o(title), artist: o(artist), album: o(album) }
    }

    #[test]
    fn missing_fields_take_their_joiners() {
        assert_eq!(fill_template("{artist} · {album}", &f("t", "beansclub", "")).as_deref(), Some("beansclub"));
        assert_eq!(fill_template("{artist} · {album}", &f("t", "", "LP")).as_deref(), Some("LP"));
        assert_eq!(fill_template("{album}", &f("t", "a", "")), None);
        assert_eq!(fill_template("Now: {TITLE} ({album})", &f("Song", "a", "")).as_deref(), Some("Now: Song"));
        assert_eq!(fill_template("x", &f("", "", "")).as_deref(), Some("x "));
        assert_eq!(fill_template("", &f("t", "a", "b")), None);
    }

    #[test]
    fn normalizes_a_hand_edited_card() {
        let v = serde_json::json!({ "details": 3, "statusName": "state", "cover": false });
        let c = DiscordCard::from_value(Some(&v));
        assert_eq!(c.details, "{title}");
        assert_eq!(c.status_name, "state");
        assert!(!c.cover);
    }
}
