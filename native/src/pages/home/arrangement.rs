//! `homeArrangement.ts`: how Home is arranged on this device, the panels on
//! it in board order, each with its size and what it shows, and which of
//! them are hidden.
//!
//! While the board has the default panels in their default sizes (in any
//! order, some maybe hidden), `board_layout` lays it out, adapting to empty
//! and hidden panels as designed. Once panels are added, removed or resized,
//! it's packed from the panels' own sizes (`pack_board`). Moving a panel swaps
//! it with the one it lands on, sizes staying where they were, so the board
//! keeps its shape. A hidden panel keeps its place and settings, and gets
//! them back when shown again; a removed one is gone.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use super::kinds::{DEFAULT_PERIOD, PANEL_HEIGHTS, PANEL_WIDTHS, PanelKind};
use super::logic::Period;

/// The search param that puts Home in customizing mode (`/?customize`).
pub const CUSTOMIZE_PARAM: &str = "customize";

/// The panels Home starts with, in board order. Also the default board's slots.
pub const DEFAULT_PANEL_IDS: [PanelKind; 7] = [
    PanelKind::Resume,
    PanelKind::Repeat,
    PanelKind::Recent,
    PanelKind::Favorites,
    PanelKind::Albums,
    PanelKind::Playlists,
    PanelKind::Artists,
];

/// At most this many panels, hidden ones included: each can mean a request.
pub const MAX_PANELS: usize = 24;
pub const MAX_TITLE_LENGTH: usize = 60;

/// A panel on Home: one kind can be there more than once, under ids of their own.
#[derive(Clone, Debug, PartialEq)]
pub struct HomePanel {
    /// Its kind for the only one of a kind, else the kind and a number ("repeat-2").
    pub id: String,
    pub kind: PanelKind,
    pub w: u8,
    pub h: u8,
    pub hidden: bool,
    /// A name of the user's own, in place of the kind's title.
    pub title: Option<String>,
    /// The Replay period a period kind shows.
    pub period: Option<Period>,
    /// The playlist a playlist panel shows.
    pub playlist: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct HomeArrangement {
    /// In board order, hidden ones included.
    pub panels: Vec<HomePanel>,
}

pub fn new_panel(kind: PanelKind, id: &str) -> HomePanel {
    let info = kind.info();
    HomePanel {
        id: id.to_string(),
        kind,
        w: info.w,
        h: info.h,
        hidden: false,
        title: None,
        period: info.period.then_some(DEFAULT_PERIOD),
        playlist: None,
    }
}

pub fn default_arrangement() -> HomeArrangement {
    HomeArrangement { panels: DEFAULT_PANEL_IDS.iter().map(|k| new_panel(*k, k.id())).collect() }
}

/// Its kind, or its kind and a number of 2 or more.
fn id_fits(id: &str, kind: PanelKind, many: bool) -> bool {
    if id == kind.id() {
        return true;
    }
    let Some(n) = id.strip_prefix(kind.id()).and_then(|r| r.strip_prefix('-')) else { return false };
    many && (1..=4).contains(&n.len())
        && n.bytes().all(|b| b.is_ascii_digit())
        && !n.starts_with('0')
        && n != "1"
}

/// The first of `kind`, `kind-2`, `kind-3`… not in `used`.
fn free_id(kind: PanelKind, used: &HashSet<String>) -> String {
    if !used.contains(kind.id()) {
        return kind.id().to_string();
    }
    (2..).map(|n| format!("{}-{n}", kind.id())).find(|id| !used.contains(id)).unwrap()
}

/// `cleanTitle`: whitespace collapsed, trimmed, at most 60 characters.
pub fn clean_title(title: &str) -> Option<String> {
    let collapsed = title.split_whitespace().collect::<Vec<_>>().join(" ");
    // `slice(0, 60)` counts UTF-16 units; characters are close enough here.
    let cut: String = collapsed.chars().take(MAX_TITLE_LENGTH).collect();
    let clean = cut.trim().to_string();
    (!clean.is_empty()).then_some(clean)
}

/// The arrangement a saved tweak describes. Whatever it gets wrong (a kind
/// this build doesn't know, a second Jump back in, a size out of range) is
/// dropped or falls back to the kind's default, so a bad or stale value never
/// shows a panel twice or breaks the board.
pub fn read_arrangement(saved: Option<&Value>) -> HomeArrangement {
    let Some(Value::Object(saved)) = saved else { return default_arrangement() };
    if let Some(Value::Array(list)) = saved.get("panels") {
        return read_panels(list);
    }
    if matches!(saved.get("slots"), Some(Value::Array(_))) || matches!(saved.get("hidden"), Some(Value::Array(_))) {
        return read_slots(saved);
    }
    default_arrangement()
}

fn read_panels(list: &[Value]) -> HomeArrangement {
    let mut used = HashSet::new();
    let mut panels = Vec::new();
    for entry in list {
        if panels.len() >= MAX_PANELS {
            break;
        }
        let Value::Object(raw) = entry else { continue };
        let Some(kind) = raw.get("kind").and_then(Value::as_str).and_then(PanelKind::parse) else { continue };
        let info = kind.info();
        let many = kind.allows_many();
        if !many && used.contains(kind.id()) {
            continue;
        }
        let playlist = raw.get("playlist").and_then(Value::as_str).filter(|s| !s.is_empty());
        // A playlist panel is nothing without its playlist.
        if info.playlist && playlist.is_none() {
            continue;
        }
        let id = match raw.get("id").and_then(Value::as_str) {
            Some(id) if id_fits(id, kind, many) && !used.contains(id) => id.to_string(),
            _ => free_id(kind, &used),
        };
        used.insert(id.clone());
        let size = |k: &str, allowed: &[u8], fallback: u8| {
            raw.get(k).and_then(Value::as_u64).and_then(|v| u8::try_from(v).ok()).filter(|v| allowed.contains(v)).unwrap_or(fallback)
        };
        panels.push(HomePanel {
            id,
            kind,
            w: size("w", &PANEL_WIDTHS, info.w),
            h: size("h", &PANEL_HEIGHTS, info.h),
            hidden: raw.get("hidden") == Some(&Value::Bool(true)),
            title: raw.get("title").and_then(Value::as_str).and_then(clean_title),
            period: info
                .period
                .then(|| raw.get("period").and_then(Value::as_str).and_then(Period::parse).unwrap_or(DEFAULT_PERIOD)),
            playlist: if info.playlist { playlist.map(str::to_string) } else { None },
        });
    }
    HomeArrangement { panels }
}

/// The first customizing build saved which default panel filled each of the
/// seven slots and which were hidden. Each panel takes the shape of the slot
/// it was in.
fn read_slots(saved: &Map<String, Value>) -> HomeArrangement {
    let slots_raw = saved.get("slots").and_then(Value::as_array);
    let mut used = HashSet::new();
    let slots: Vec<Option<PanelKind>> = (0..DEFAULT_PANEL_IDS.len())
        .map(|i| {
            let kind = slots_raw
                .and_then(|s| s.get(i))
                .and_then(Value::as_str)
                .and_then(|s| DEFAULT_PANEL_IDS.iter().copied().find(|k| k.id() == s))?;
            used.insert(kind).then_some(kind)
        })
        .collect();
    // Unclaimed slots take the panels left over, in default order.
    let mut spare = DEFAULT_PANEL_IDS.iter().copied().filter(|k| !used.contains(k));
    let hidden: HashSet<&str> =
        saved.get("hidden").and_then(Value::as_array).map(|h| h.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    HomeArrangement {
        panels: slots
            .into_iter()
            .enumerate()
            .map(|(i, kind)| {
                let kind = kind.unwrap_or_else(|| spare.next().unwrap());
                let shape = DEFAULT_PANEL_IDS[i].info();
                HomePanel { w: shape.w, h: shape.h, hidden: hidden.contains(kind.id()), ..new_panel(kind, kind.id()) }
            })
            .collect(),
    }
}

/// The tweak to save, or None for the default board.
pub fn arrangement_tweak(arrangement: &HomeArrangement) -> Option<Value> {
    if is_default_arrangement(arrangement) {
        return None;
    }
    let panels: Vec<Value> = arrangement
        .panels
        .iter()
        .map(|p| {
            let mut out = json!({ "id": p.id, "kind": p.kind.id(), "w": p.w, "h": p.h });
            let o = out.as_object_mut().unwrap();
            if p.hidden {
                o.insert("hidden".into(), Value::Bool(true));
            }
            if let Some(t) = &p.title {
                o.insert("title".into(), Value::String(t.clone()));
            }
            if let Some(period) = p.period {
                o.insert("period".into(), Value::String(period.key()));
            }
            if let Some(pl) = &p.playlist {
                o.insert("playlist".into(), Value::String(pl.clone()));
            }
            out
        })
        .collect();
    Some(json!({ "panels": panels }))
}

pub fn is_default_arrangement(arrangement: &HomeArrangement) -> bool {
    let usual = default_arrangement();
    arrangement.panels.len() == usual.panels.len()
        && arrangement.panels.iter().zip(&usual.panels).all(|(p, u)| {
            p.id == u.id && p.w == u.w && p.h == u.h && !p.hidden && p.title.is_none() && p.period == u.period
        })
}

/// The panel in each of the default board's slots (`DEFAULT_PANEL_IDS`
/// order), while the board still has its shape: the default panels, each
/// once, in the default sizes, whatever order they're in and whichever are
/// hidden. None once panels are added, removed or resized.
pub fn default_slots(arrangement: &HomeArrangement) -> Option<&[HomePanel]> {
    let panels = &arrangement.panels;
    if panels.len() != DEFAULT_PANEL_IDS.len() {
        return None;
    }
    let kinds: HashSet<PanelKind> = panels.iter().map(|p| p.kind).collect();
    if !DEFAULT_PANEL_IDS.iter().all(|k| kinds.contains(k)) {
        return None;
    }
    let shaped = panels.iter().zip(DEFAULT_PANEL_IDS).all(|(p, slot)| p.w == slot.info().w && p.h == slot.info().h);
    shaped.then_some(panels.as_slice())
}

pub fn find_panel<'a>(arrangement: &'a HomeArrangement, id: &str) -> Option<&'a HomePanel> {
    arrangement.panels.iter().find(|p| p.id == id)
}

/// Puts `a` where `b` is and `b` where `a` is; the sizes stay with the places.
pub fn swap_panels(arrangement: &HomeArrangement, a: &str, b: &str) -> HomeArrangement {
    let (Some(from), Some(to)) = (find_panel(arrangement, a).cloned(), find_panel(arrangement, b).cloned()) else {
        return arrangement.clone();
    };
    if a == b {
        return arrangement.clone();
    }
    HomeArrangement {
        panels: arrangement
            .panels
            .iter()
            .map(|p| {
                if p.id == a {
                    HomePanel { w: from.w, h: from.h, ..to.clone() }
                } else if p.id == b {
                    HomePanel { w: to.w, h: to.h, ..from.clone() }
                } else {
                    p.clone()
                }
            })
            .collect(),
    }
}

pub fn set_panel_hidden(arrangement: &HomeArrangement, id: &str, hidden: bool) -> HomeArrangement {
    match find_panel(arrangement, id) {
        Some(p) if p.hidden != hidden => update_panel(arrangement, id, PanelChange { hidden: Some(hidden), ..Default::default() }),
        _ => arrangement.clone(),
    }
}

/// `PanelChange`: what a panel's settings can change.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PanelChange {
    pub w: Option<u8>,
    pub h: Option<u8>,
    pub hidden: Option<bool>,
    /// `Some("")` goes back to the kind's title.
    pub title: Option<String>,
    pub period: Option<Period>,
    pub playlist: Option<String>,
}

pub fn update_panel(arrangement: &HomeArrangement, id: &str, change: PanelChange) -> HomeArrangement {
    HomeArrangement {
        panels: arrangement
            .panels
            .iter()
            .map(|p| {
                if p.id != id {
                    return p.clone();
                }
                let mut next = p.clone();
                if let Some(w) = change.w {
                    next.w = w;
                }
                if let Some(h) = change.h {
                    next.h = h;
                }
                if let Some(hidden) = change.hidden {
                    next.hidden = hidden;
                }
                if let Some(period) = change.period {
                    next.period = Some(period);
                }
                if let Some(pl) = &change.playlist {
                    next.playlist = Some(pl.clone());
                }
                // An emptied name goes back to the kind's title.
                if let Some(t) = &change.title {
                    next.title = clean_title(t);
                } else if let Some(t) = &next.title {
                    next.title = clean_title(t);
                }
                next
            })
            .collect(),
    }
}

/// Whether one more `kind` can go on the board (or an existing one be shown).
pub fn can_add(arrangement: &HomeArrangement, kind: PanelKind) -> bool {
    if !kind.allows_many() && arrangement.panels.iter().any(|p| p.kind == kind) {
        return arrangement.panels.iter().any(|p| p.kind == kind && p.hidden);
    }
    arrangement.panels.len() < MAX_PANELS
}

/// A new panel of `kind` at the end of the board, or the hidden one shown
/// for a kind that can only be there once. Says which panel that is.
pub fn add_panel(
    arrangement: &HomeArrangement,
    kind: PanelKind,
    period: Option<Period>,
    playlist: Option<String>,
) -> (HomeArrangement, Option<String>) {
    if !kind.allows_many()
        && let Some(existing) = arrangement.panels.iter().find(|p| p.kind == kind)
    {
        return (set_panel_hidden(arrangement, &existing.id.clone(), false), Some(existing.id.clone()));
    }
    if !can_add(arrangement, kind) {
        return (arrangement.clone(), None);
    }
    let used: HashSet<String> = arrangement.panels.iter().map(|p| p.id.clone()).collect();
    let mut panel = new_panel(kind, &free_id(kind, &used));
    if period.is_some() {
        panel.period = period;
    }
    if playlist.is_some() {
        panel.playlist = playlist;
    }
    let id = panel.id.clone();
    let mut panels = arrangement.panels.clone();
    panels.push(panel);
    (HomeArrangement { panels }, Some(id))
}

pub fn remove_panel(arrangement: &HomeArrangement, id: &str) -> HomeArrangement {
    HomeArrangement { panels: arrangement.panels.iter().filter(|p| p.id != id).cloned().collect() }
}

/// A panel's title: its own name, a playlist's name, or its kind's title.
pub fn panel_title(panel: &HomePanel, playlists: Option<&[crate::api::Playlist]>) -> String {
    if let Some(t) = &panel.title {
        return t.clone();
    }
    if panel.kind == PanelKind::Playlist {
        return playlists
            .and_then(|ps| ps.iter().find(|p| Some(&p.id) == panel.playlist.as_ref()))
            .map(|p| p.name.clone())
            .unwrap_or_else(|| PanelKind::Playlist.info().title.to_string());
    }
    panel.kind.info().title.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(a: &HomeArrangement) -> Vec<String> {
        a.panels.iter().map(|p| format!("{} {}x{}{}", p.id, p.w, p.h, if p.hidden { " hidden" } else { "" })).collect()
    }

    #[test]
    fn swaps_hides_and_shows_in_place() {
        let d = default_arrangement();
        let swapped = swap_panels(&d, "resume", "repeat");
        assert_eq!(summary(&swapped)[..2], ["repeat 4x1", "resume 2x2"]);
        assert_eq!(swap_panels(&swapped, "repeat", "resume"), d);
        let hidden = set_panel_hidden(&swapped, "albums", true);
        assert_eq!(hidden.panels.iter().filter(|p| p.hidden).map(|p| p.id.as_str()).collect::<Vec<_>>(), ["albums"]);
        assert!(is_default_arrangement(&set_panel_hidden(&set_panel_hidden(&d, "albums", true), "albums", false)));
    }

    #[test]
    fn adds_under_own_ids_and_shows_hidden_ones() {
        let d = default_arrangement();
        let (first, id) = add_panel(&d, PanelKind::Repeat, Some(Period::All), None);
        assert_eq!(id.as_deref(), Some("repeat-2"));
        let (second, id) = add_panel(&first, PanelKind::Repeat, None, None);
        assert_eq!(id.as_deref(), Some("repeat-3"));
        let r2 = find_panel(&second, "repeat-2").unwrap();
        assert_eq!((r2.w, r2.h, r2.period), (2, 2, Some(Period::All)));
        assert_eq!(find_panel(&second, "repeat-3").unwrap().period, Some(Period::Last30));
        assert_eq!(add_panel(&remove_panel(&second, "repeat-2"), PanelKind::Repeat, None, None).1.as_deref(), Some("repeat-2"));

        let hidden = set_panel_hidden(&d, "recent", true);
        let (shown, id) = add_panel(&hidden, PanelKind::Recent, None, None);
        assert_eq!(id.as_deref(), Some("recent"));
        assert_eq!(shown.panels.len(), 7);
        assert!(is_default_arrangement(&shown));
        assert_eq!(add_panel(&d, PanelKind::Recent, None, None).0, d);

        let mut full = d.clone();
        while full.panels.len() < MAX_PANELS {
            full = add_panel(&full, PanelKind::Stats, None, None).0;
        }
        assert_eq!(add_panel(&full, PanelKind::Genres, None, None), (full.clone(), None));
    }

    #[test]
    fn renames_and_clears() {
        let d = default_arrangement();
        let named = update_panel(&d, "repeat", PanelChange { title: Some("  Heavy   rotation ".into()), ..Default::default() });
        assert_eq!(find_panel(&named, "repeat").unwrap().title.as_deref(), Some("Heavy rotation"));
        assert!(!is_default_arrangement(&named));
        let cleared = update_panel(&named, "repeat", PanelChange { title: Some("   ".into()), ..Default::default() });
        assert_eq!(find_panel(&cleared, "repeat").unwrap().title, None);
        assert!(is_default_arrangement(&cleared));
    }

    #[test]
    fn saves_nothing_for_default_and_reads_back() {
        let d = default_arrangement();
        assert_eq!(arrangement_tweak(&d), None);
        let mut a = set_panel_hidden(&swap_panels(&d, "resume", "artists"), "favorites", true);
        a = add_panel(&a, PanelKind::Playlist, None, Some("pl-1".into())).0;
        a = add_panel(&a, PanelKind::Genres, Some(Period::Year(2024)), None).0;
        a = update_panel(&a, "artists", PanelChange { title: Some("Who I play".into()), w: Some(3), ..Default::default() });
        let saved = arrangement_tweak(&a).unwrap();
        let panels = saved["panels"].as_array().unwrap();
        assert_eq!(panels[panels.len() - 2], json!({ "id": "playlist", "kind": "playlist", "w": 2, "h": 1, "playlist": "pl-1" }));
        assert_eq!(panels[panels.len() - 1], json!({ "id": "genres", "kind": "genres", "w": 2, "h": 1, "period": "year:2024" }));
        assert_eq!(panels[0], json!({ "id": "artists", "kind": "artists", "w": 3, "h": 1, "title": "Who I play", "period": "last-30" }));
        assert_eq!(panels[3]["hidden"], json!(true));
        assert_eq!(read_arrangement(Some(&saved)), a);
    }

    #[test]
    fn reads_first_build_slots() {
        let read = read_arrangement(Some(&json!({
            "slots": ["repeat", "resume", "recent", "favorites", "albums", "playlists", "artists"],
            "hidden": ["favorites"],
        })));
        assert_eq!(
            summary(&read),
            ["repeat 4x1", "resume 2x2", "recent 2x1", "favorites 2x1 hidden", "albums 4x1", "playlists 2x1", "artists 6x1"]
        );
        let repaired = read_arrangement(Some(&json!({
            "slots": ["artists", "radio", "artists", "recent", "albums", "favorites"],
            "hidden": ["radio", "albums"],
        })));
        assert_eq!(
            repaired.panels.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["artists", "resume", "repeat", "recent", "albums", "favorites", "playlists"]
        );
        assert_eq!(repaired.panels.iter().filter(|p| p.hidden).map(|p| p.id.as_str()).collect::<Vec<_>>(), ["albums"]);
        assert_eq!(read_arrangement(Some(&json!({ "slots": [], "hidden": [] }))), default_arrangement());
    }

    #[test]
    fn repairs_a_broken_save() {
        let read = read_arrangement(Some(&json!({
            "panels": [
                { "id": "resume", "kind": "resume", "w": 4, "h": 1 },
                { "id": "resume", "kind": "resume", "w": 4, "h": 1 },
                { "id": "radio", "kind": "radio", "w": 2, "h": 1 },
                { "id": "repeat", "kind": "repeat", "w": 5, "h": 9, "period": "yesterday", "title": "x".repeat(80) },
                { "id": "repeat", "kind": "repeat", "w": 2, "h": 1 },
                { "id": "repeat-1", "kind": "repeat", "w": 2, "h": 1 },
                { "id": "playlist", "kind": "playlist", "w": 2, "h": 1 },
                { "id": "<script>", "kind": "playlist", "w": 2, "h": 1, "playlist": "pl-9" },
                null,
            ],
        })));
        assert_eq!(read.panels.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["resume", "repeat", "repeat-2", "repeat-3", "playlist"]);
        assert_eq!((read.panels[1].w, read.panels[1].h, read.panels[1].period), (2, 2, Some(Period::Last30)));
        assert_eq!(read.panels[1].title.as_ref().unwrap().len(), 60);
        assert_eq!(read.panels[4].playlist.as_deref(), Some("pl-9"));
        let many: Vec<Value> = (0..40).map(|_| json!({ "id": "x", "kind": "stats", "w": 2, "h": 1 })).collect();
        assert_eq!(read_arrangement(Some(&json!({ "panels": many }))).panels.len(), MAX_PANELS);
        assert!(read_arrangement(Some(&json!({ "panels": [] }))).panels.is_empty());
        assert_eq!(read_arrangement(None), default_arrangement());
        assert_eq!(read_arrangement(Some(&json!({ "slots": "nope", "hidden": null }))), default_arrangement());
    }

    #[test]
    fn default_slots_survive_swaps_hides_renames_only() {
        let d = default_arrangement();
        let swapped = set_panel_hidden(&swap_panels(&d, "albums", "resume"), "repeat", true);
        let renamed = update_panel(&swapped, "recent", PanelChange { title: Some("Lately".into()), ..Default::default() });
        assert_eq!(
            default_slots(&renamed).unwrap().iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["albums", "repeat", "recent", "favorites", "resume", "playlists", "artists"]
        );
        assert!(default_slots(&update_panel(&d, "recent", PanelChange { w: Some(3), ..Default::default() })).is_none());
        assert!(default_slots(&add_panel(&d, PanelKind::Stats, None, None).0).is_none());
        assert!(default_slots(&remove_panel(&d, "artists")).is_none());
        assert!(default_slots(&add_panel(&remove_panel(&d, "artists"), PanelKind::Repeat, None, None).0).is_none());
    }
}
