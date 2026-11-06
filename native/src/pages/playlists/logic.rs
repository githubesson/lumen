//! The pure rules the playlist pages follow, from core:
//! `playlist-permissions.ts`, `playlist-details.ts`, `playlist-tracks.ts`,
//! `track-sort.ts`, plus `pages/playlist/trackSort.ts` and the bits of
//! `lib/format.ts` (`fmtDate`, `pluralize`) and `errorMessage` they use.
//
// TODO(api-merge): swap for `crate::core::{playlist_permissions,
// playlist_details, playlist_tracks, track_sort}`, `crate::format::{fmt_date,
// pluralize}` and `crate::api::client::error_message` once the API port lands.

use std::cmp::Ordering;

use crate::api::{ApiError, EffectiveRole, Me, Playlist, PlaylistTrackEntry, Role, Visibility};

use super::requests::{Collaborator, CollaboratorStatus};

// ── playlist-permissions ──────────────────────────────────────────────────

/// What the signed-in user may do with a playlist (`PlaylistPermissions`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Permissions {
    pub role: EffectiveRole,
    pub is_owner: bool,
    /// Add, remove and reorder tracks: the owner and editors.
    pub can_edit_tracks: bool,
    /// Name, description and visibility: the owner only.
    pub can_edit_details: bool,
    pub can_change_cover: bool,
    pub can_delete: bool,
    /// Anyone on a collaborative playlist, and its owner after making it
    /// private, so leftover collaborators can still be removed.
    pub can_see_collaborators: bool,
    pub can_manage_collaborators: bool,
    /// The server refuses invites to a private playlist.
    pub can_invite: bool,
    pub can_toggle_tidal_auto_download: bool,
}

/// `playlistPermissions`: a missing role grants nothing.
pub fn permissions(playlist: Option<&Playlist>, me: Option<&Me>) -> Permissions {
    let role = playlist.and_then(|p| p.effective_role).unwrap_or_default();
    let has_access = role != EffectiveRole::None;
    let is_owner = role == EffectiveRole::Owner;
    let collaborative = playlist.is_some_and(|p| p.visibility == Visibility::Collaborative);
    Permissions {
        role,
        is_owner,
        can_edit_tracks: is_owner || role == EffectiveRole::Editor,
        can_edit_details: is_owner,
        can_change_cover: is_owner,
        can_delete: is_owner,
        can_see_collaborators: is_owner || (has_access && collaborative),
        can_manage_collaborators: is_owner,
        can_invite: is_owner && collaborative,
        can_toggle_tidal_auto_download: has_access && me.is_some_and(|m| m.role == Role::Admin),
    }
}

/// `collaboratorPermissions`: what the user may do to one collaborator row.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CollaboratorRow {
    pub is_self: bool,
    pub can_remove: bool,
    pub can_change_role: bool,
}

pub fn collaborator_permissions(p: &Permissions, c: &Collaborator, me: Option<&Me>) -> CollaboratorRow {
    let is_self = me.is_some_and(|m| !m.id.is_empty() && m.id == c.user_id);
    CollaboratorRow {
        is_self,
        can_remove: p.can_manage_collaborators || is_self,
        can_change_role: p.can_manage_collaborators && c.status == CollaboratorStatus::Accepted,
    }
}

/// The role as the header and subtitles spell it ("editor").
pub fn role_name(role: EffectiveRole) -> &'static str {
    match role {
        EffectiveRole::Owner => "owner",
        EffectiveRole::Editor => "editor",
        EffectiveRole::Viewer => "viewer",
        EffectiveRole::None => "",
    }
}

// ── playlist-details ──────────────────────────────────────────────────────

/// `PlaylistDetailsPayload`: the body create and update take.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Details {
    pub name: String,
    pub description: String,
    pub visibility: Visibility,
}

/// `playlistDetailsPayload`: both text fields trimmed.
pub fn details_payload(name: &str, description: &str, visibility: Visibility) -> Details {
    Details { name: name.trim().to_string(), description: description.trim().to_string(), visibility }
}

/// `playlistDetailsForm`: a saved playlist's values, untrimmed as they show.
pub fn details_form(p: &Playlist) -> Details {
    Details { name: p.name.clone(), description: p.description.clone().unwrap_or_default(), visibility: p.visibility }
}

/// The server's rule: a name with something besides whitespace.
pub fn is_valid_name(name: &str) -> bool {
    !name.trim().is_empty()
}

/// `samePlaylistDetails`.
pub fn same_details(a: &Details, b: &Details) -> bool {
    details_payload(&a.name, &a.description, a.visibility) == details_payload(&b.name, &b.description, b.visibility)
}

/// The server's cap on a cover upload.
pub const COVER_MAX_BYTES: u64 = 16 << 20;

/// `playlistCoverSizeError`.
pub fn cover_size_error(bytes: Option<u64>) -> Option<&'static str> {
    (bytes? > COVER_MAX_BYTES).then_some("That image is over 16 MB. Choose a smaller one.")
}

/// `playlistSubtitle`: "Collaborative · editor".
pub fn subtitle(p: &Playlist) -> String {
    let visibility = if p.visibility == Visibility::Collaborative { "Collaborative" } else { "Private" };
    match p.effective_role {
        Some(role) if role != EffectiveRole::Owner && role != EffectiveRole::None => {
            format!("{visibility} · {}", role_name(role))
        }
        _ => visibility.to_string(),
    }
}

// ── playlist-tracks ───────────────────────────────────────────────────────

/// While TIDAL tracks are queued for download, refetch every 20 s.
pub const AUTO_DOWNLOAD_REFRESH_MS: u64 = 20_000;

/// `playlistTidalQueued`: the server's count, else the rows still on TIDAL.
pub fn tidal_queued(tracks: &[PlaylistTrackEntry], queued: Option<u32>) -> u32 {
    queued.unwrap_or_else(|| tracks.iter().filter(|t| t.source == Some(crate::api::TrackSource::Tidal)).count() as u32)
}

/// `playlistAutoDownloadRefetchMs`: when to look again, or None.
pub fn auto_download_refetch_ms(
    tracks: &[PlaylistTrackEntry],
    queued: Option<u32>,
    retry_at: Option<&str>,
    now_ms: i64,
) -> Option<u64> {
    if tidal_queued(tracks, queued) > 0 {
        return Some(AUTO_DOWNLOAD_REFRESH_MS);
    }
    let at = parse_iso_ms(retry_at?)?;
    Some((at - now_ms).max(AUTO_DOWNLOAD_REFRESH_MS as i64) as u64)
}

/// `removePlaylistEntry`: drop the row at `position`, moving later rows up.
pub fn remove_entry(entries: &[PlaylistTrackEntry], position: u32) -> Vec<PlaylistTrackEntry> {
    if !entries.iter().any(|e| e.position == position) {
        return entries.to_vec();
    }
    entries
        .iter()
        .filter(|e| e.position != position)
        .map(|e| {
            let mut e = e.clone();
            if e.position > position {
                e.position -= 1;
            }
            e
        })
        .collect()
}

/// `movePlaylistEntry`: the row at index `from` dragged to index `to`; the
/// rows keep the same set of positions.
pub fn move_entry(entries: &[PlaylistTrackEntry], from: usize, to: usize) -> Vec<PlaylistTrackEntry> {
    if from == to || from >= entries.len() || to >= entries.len() {
        return entries.to_vec();
    }
    let mut moved = entries.to_vec();
    let entry = moved.remove(from);
    moved.insert(to, entry);
    let mut slots: Vec<u32> = entries.iter().map(|e| e.position).collect();
    slots.sort_unstable();
    for (e, slot) in moved.iter_mut().zip(slots) {
        e.position = slot;
    }
    moved
}

// ── track-sort ────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SortKey {
    #[default]
    Custom,
    Title,
    Duration,
    Plays,
}

impl SortKey {
    pub fn as_str(self) -> &'static str {
        match self {
            SortKey::Custom => "custom",
            SortKey::Title => "title",
            SortKey::Duration => "duration",
            SortKey::Plays => "plays",
        }
    }
    pub fn parse(s: &str) -> SortKey {
        match s {
            "title" => SortKey::Title,
            "duration" => SortKey::Duration,
            "plays" => SortKey::Plays,
            _ => SortKey::Custom,
        }
    }
    /// `SORT_DEFAULT_ASC`: play counts read best biggest-first.
    pub fn default_asc(self) -> bool {
        self != SortKey::Plays
    }
}

/// `SORT_OPTIONS` (`pages/playlist/trackSort.ts`).
pub const SORT_OPTIONS: [(SortKey, &str); 4] =
    [(SortKey::Custom, "Custom order"), (SortKey::Title, "Title"), (SortKey::Duration, "Length"), (SortKey::Plays, "Plays")];

fn is_emoji(c: char) -> bool {
    matches!(c as u32,
        0x1F000..=0x1FFFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0x2300..=0x23FF | 0xFE00..=0xFE0F | 0x200D | 0x20E3)
}

/// `sortTitleKey`: emoji stripped, whitespace collapsed; the title itself
/// when nothing would be left.
pub fn sort_title_key(title: &str) -> String {
    let stripped: String = title.chars().filter(|c| !is_emoji(*c)).collect();
    let collapsed = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() { title.to_string() } else { collapsed }
}

/// A letter with its accent dropped and case folded, as the base-sensitivity
/// collator compares it.
fn base_char(c: char) -> char {
    let c = c.to_lowercase().next().unwrap_or(c);
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ě' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ī' => 'i',
        'ñ' | 'ń' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' => 'u',
        'ý' | 'ÿ' => 'y',
        'š' | 'ś' => 's',
        'ž' | 'ź' | 'ż' => 'z',
        other => other,
    }
}

/// `Intl.Collator(undefined, { sensitivity: "base", numeric: true })`, near
/// enough: case and accents ignored, digit runs compared as numbers.
pub fn collate(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let mut n = String::new();
                while let Some(c) = x.peek().copied().filter(char::is_ascii_digit) {
                    n.push(c);
                    x.next();
                }
                let mut m = String::new();
                while let Some(d) = y.peek().copied().filter(char::is_ascii_digit) {
                    m.push(d);
                    y.next();
                }
                let (n, m) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                let o = n.len().cmp(&m.len()).then_with(|| n.cmp(m));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(c), Some(d)) => {
                let o = base_char(c).cmp(&base_char(d));
                if o != Ordering::Equal {
                    return o;
                }
                x.next();
                y.next();
            }
        }
    }
}

/// `compareSortableTracks` with precomputed title keys.
fn compare(a: &PlaylistTrackEntry, ka: &str, b: &PlaylistTrackEntry, kb: &str, key: SortKey) -> Ordering {
    let by_title = || collate(ka, kb);
    match key {
        SortKey::Custom => Ordering::Equal,
        SortKey::Title => by_title(),
        SortKey::Duration => a.duration_ms.cmp(&b.duration_ms).then_with(by_title),
        SortKey::Plays => a.play_count.unwrap_or(0).cmp(&b.play_count.unwrap_or(0)).then_with(by_title),
    }
}

/// `sortForDisplay`: the saved order for `custom`, else a sorted copy,
/// reversed when descending. Gives indices into `items`.
pub fn sort_for_display(items: &[PlaylistTrackEntry], key: SortKey, asc: bool) -> Vec<usize> {
    let mut order: Vec<usize> = (0..items.len()).collect();
    if key == SortKey::Custom {
        return order;
    }
    let keys: Vec<String> = items.iter().map(|t| sort_title_key(&t.title)).collect();
    order.sort_by(|&i, &j| compare(&items[i], &keys[i], &items[j], &keys[j], key));
    if !asc {
        order.reverse();
    }
    order
}

/// `usePlaylistTrackKeys`' search key: title, artist and album, lowercased.
pub fn search_key(t: &PlaylistTrackEntry) -> String {
    format!("{} {} {}", t.title, t.artist.as_deref().unwrap_or(""), t.album_title.as_deref().unwrap_or("")).to_lowercase()
}

// ── format ────────────────────────────────────────────────────────────────

/// CSS `60ch` at `size` px: sixty of Geist's "0" (663 units of 1000).
pub fn ch60(size: f32) -> f32 {
    60.0 * 0.663 * size
}

/// `pluralize`: "1 track", "9 tracks".
pub fn pluralize(n: usize, word: &str) -> String {
    if n == 1 { format!("1 {word}") } else { format!("{n} {word}s") }
}

/// `errorMessage(err, fallback)`: the server's text, else the fallback.
pub fn error_message(e: &ApiError, fallback: &str) -> String {
    if e.status == 0 || e.message.trim().is_empty() { fallback.to_string() } else { e.message.clone() }
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// An RFC 3339 timestamp as milliseconds since the epoch.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = if s.len() >= 19 { (num(11..13)?, num(14..16)?, num(17..19)?) } else { (0, 0, 0) };
    let mut rest = s.get(19..).unwrap_or("");
    let mut ms = 0;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
        ms = format!("{:0<3}", &digits[..digits.len().min(3)]).parse().unwrap_or(0);
        rest = &frac[digits.len()..];
    }
    let offset_min = match rest.as_bytes().first() {
        Some(b'+') | Some(b'-') => {
            let sign = if rest.starts_with('-') { -1 } else { 1 };
            let hh: i64 = rest.get(1..3)?.parse().ok()?;
            let mm: i64 = rest.get(4..6).or_else(|| rest.get(3..5)).and_then(|v| v.parse().ok()).unwrap_or(0);
            sign * (hh * 60 + mm)
        }
        _ => 0,
    };
    let days = days_from_civil(y, mo, d);
    Some(((days * 86400 + h * 3600 + mi * 60 + sec) - offset_min * 60) * 1000 + ms)
}

/// `fmtDate`: the en-US medium date ("Sep 1, 2026").
// TODO(api-merge): `crate::format::fmt_date` shows it in the local zone; this is UTC.
pub fn fmt_date(iso: &str) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let Some(ms) = parse_iso_ms(iso) else { return "Invalid Date".into() };
    let (y, m, d) = civil_from_days(ms.div_euclid(86_400_000));
    format!("{} {d}, {y}", MONTHS[(m - 1) as usize])
}

/// Milliseconds since the epoch, now.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(position: u32, id: &str) -> PlaylistTrackEntry {
        PlaylistTrackEntry {
            position,
            track_id: id.into(),
            db_track_id: None,
            source: None,
            source_id: None,
            source_album_id: None,
            title: id.into(),
            album_id: None,
            album_title: None,
            track_no: None,
            duration_ms: 0,
            artist: None,
            has_cover: None,
            cover_url: None,
            added_by_id: None,
            added_by: None,
            added_at: String::new(),
            play_count: None,
        }
    }

    fn playlist(role: Option<EffectiveRole>, visibility: Visibility) -> Playlist {
        serde_json::from_value(serde_json::json!({"id": "p", "name": "P"})).map(|p: Playlist| Playlist {
            effective_role: role,
            visibility,
            ..p
        })
        .unwrap()
    }

    #[test]
    fn permissions_follow_the_role() {
        let admin = Me { id: "u".into(), username: "u".into(), role: Role::Admin, must_reset_password: false };
        let owner = permissions(Some(&playlist(Some(EffectiveRole::Owner), Visibility::Private)), Some(&admin));
        assert!(owner.can_edit_details && owner.can_see_collaborators && !owner.can_invite);
        assert!(owner.can_toggle_tidal_auto_download);
        let editor = permissions(Some(&playlist(Some(EffectiveRole::Editor), Visibility::Collaborative)), None);
        assert!(editor.can_edit_tracks && editor.can_see_collaborators && !editor.can_edit_details);
        assert!(!editor.can_toggle_tidal_auto_download);
        let none = permissions(Some(&playlist(None, Visibility::Collaborative)), Some(&admin));
        assert_eq!(none, Permissions::default());
    }

    #[test]
    fn removes_and_shifts_positions() {
        let rows = vec![entry(0, "a"), entry(2, "b"), entry(3, "c")];
        let next = remove_entry(&rows, 2);
        assert_eq!(next.iter().map(|e| (e.position, e.track_id.as_str())).collect::<Vec<_>>(), [(0, "a"), (2, "c")]);
        assert_eq!(remove_entry(&rows, 9), rows);
    }

    #[test]
    fn moves_keep_the_slots() {
        let rows = vec![entry(0, "a"), entry(2, "b"), entry(5, "c")];
        let next = move_entry(&rows, 0, 2);
        assert_eq!(next.iter().map(|e| (e.position, e.track_id.as_str())).collect::<Vec<_>>(), [(0, "b"), (2, "c"), (5, "a")]);
    }

    #[test]
    fn sorts_titles_naturally() {
        assert_eq!(sort_title_key("🔥  Song  2"), "Song 2");
        assert_eq!(sort_title_key("🔥"), "🔥");
        assert_eq!(collate("track 10", "Track 9"), Ordering::Greater);
        assert_eq!(collate("Émile", "emile"), Ordering::Equal);
        let mut rows = vec![entry(0, "b"), entry(1, "a"), entry(2, "c")];
        rows[0].duration_ms = 5;
        rows[1].duration_ms = 5;
        rows[2].duration_ms = 1;
        assert_eq!(sort_for_display(&rows, SortKey::Duration, true), [2, 1, 0]);
        assert_eq!(sort_for_display(&rows, SortKey::Title, false), [2, 0, 1]);
    }

    #[test]
    fn formats_dates_and_details() {
        assert_eq!(fmt_date("2026-09-01T20:15:00.000Z"), "Sep 1, 2026");
        assert_eq!(fmt_date("2025-12-01T09:00:00Z"), "Dec 1, 2025");
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01+01:00"), Some(1000 - 3_600_000));
        assert!(same_details(&details_payload(" a ", "", Visibility::Private), &details_payload("a", " ", Visibility::Private)));
        assert_eq!(cover_size_error(Some(17 << 20)), Some("That image is over 16 MB. Choose a smaller one."));
        assert_eq!(cover_size_error(None), None);
        assert_eq!(pluralize(1, "track"), "1 track");
    }

    #[test]
    fn refetches_while_queued_or_retrying() {
        let mut rows = vec![entry(0, "a")];
        assert_eq!(auto_download_refetch_ms(&rows, None, None, 0), None);
        rows[0].source = Some(crate::api::TrackSource::Tidal);
        assert_eq!(auto_download_refetch_ms(&rows, None, None, 0), Some(20_000));
        assert_eq!(auto_download_refetch_ms(&rows, Some(0), Some("1970-01-01T00:01:00Z"), 0), Some(60_000));
    }
}
