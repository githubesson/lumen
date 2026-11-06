//! `core/src/track-sort.ts`: display-only sorting for playlist track lists
//! (never the saved order), and [`collate`], the stand-in for
//! `Intl.Collator(undefined, { sensitivity: "base", numeric: true })`.

use std::cmp::Ordering;

use crate::api::{PlaylistTrackEntry, TrackListItem};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub enum SortKey {
    #[default]
    Custom,
    Title,
    Duration,
    Plays,
}

impl SortKey {
    /// `SORT_DEFAULT_ASC`: ascending for names and lengths; play counts
    /// read best biggest-first.
    pub fn default_asc(self) -> bool {
        !matches!(self, SortKey::Plays)
    }
}

fn is_emoji(c: char) -> bool {
    matches!(c as u32,
        0x1F000..=0x1FFFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0x2300..=0x23FF | 0xFE00..=0xFE0F | 0x200D | 0x20E3)
}

/// `sortTitleKey`: emoji stripped and whitespace collapsed, so "🔥 Song"
/// sorts under S; the original when nothing would be left.
pub fn sort_title_key(title: &str) -> String {
    let stripped: String = title.chars().filter(|c| !is_emoji(*c)).collect();
    let collapsed = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() { title.to_string() } else { collapsed }
}

/// The track fields the comparator needs, whatever row type wraps them.
pub trait SortableTrack {
    fn sort_title(&self) -> &str;
    fn sort_duration_ms(&self) -> u64;
    fn sort_play_count(&self) -> Option<u64> {
        None
    }
}

impl SortableTrack for PlaylistTrackEntry {
    fn sort_title(&self) -> &str {
        &self.title
    }
    fn sort_duration_ms(&self) -> u64 {
        self.duration_ms
    }
    fn sort_play_count(&self) -> Option<u64> {
        self.play_count
    }
}

impl SortableTrack for TrackListItem {
    fn sort_title(&self) -> &str {
        &self.title
    }
    fn sort_duration_ms(&self) -> u64 {
        self.duration_ms
    }
}

/// `compareSortableTracks`: every non-title key falls back to title order;
/// `Custom` is always equal, keeping the caller's order.
pub fn compare_sortable_tracks<A: SortableTrack, B: SortableTrack>(a: &A, b: &B, key: SortKey) -> Ordering {
    compare_with_title_keys(a, b, key, &sort_title_key(a.sort_title()), &sort_title_key(b.sort_title()))
}

/// [`compare_sortable_tracks`] with title keys the caller computed once.
pub fn compare_with_title_keys<A: SortableTrack, B: SortableTrack>(
    a: &A,
    b: &B,
    key: SortKey,
    title_a: &str,
    title_b: &str,
) -> Ordering {
    let by_title = || collate(title_a, title_b);
    match key {
        SortKey::Title => by_title(),
        SortKey::Duration => a.sort_duration_ms().cmp(&b.sort_duration_ms()).then_with(by_title),
        SortKey::Plays => a.sort_play_count().unwrap_or(0).cmp(&b.sort_play_count().unwrap_or(0)).then_with(by_title),
        SortKey::Custom => Ordering::Equal,
    }
}

/// `sortForDisplay`: the saved order for `Custom`, otherwise a sorted copy,
/// reversed when descending.
pub fn sort_for_display<T: SortableTrack + Clone>(items: &[T], key: SortKey, asc: bool) -> Vec<T> {
    if key == SortKey::Custom {
        return items.to_vec();
    }
    let keyed: Vec<(String, &T)> = items.iter().map(|t| (sort_title_key(t.sort_title()), t)).collect();
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by(|&i, &j| compare_with_title_keys(keyed[i].1, keyed[j].1, key, &keyed[i].0, &keyed[j].0));
    if !asc {
        order.reverse();
    }
    order.into_iter().map(|i| items[i].clone()).collect()
}

/// Base letter of a Latin letter with a diacritic (`sensitivity: "base"`).
fn base_letter(c: char) -> char {
    match c {
        'à'..='å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
        'ď' | 'đ' => 'd',
        'è'..='ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
        'ĥ' | 'ħ' => 'h',
        'ì'..='ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => 'i',
        'ĵ' => 'j',
        'ķ' => 'k',
        'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => 'l',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'ò'..='ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => 'o',
        'ŕ' | 'ŗ' | 'ř' => 'r',
        'ś' | 'ŝ' | 'ş' | 'š' => 's',
        'ţ' | 'ť' | 'ŧ' => 't',
        'ù'..='ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
        'ŵ' => 'w',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'ź' | 'ż' | 'ž' => 'z',
        other => other,
    }
}

fn fold(s: &str) -> Vec<char> {
    s.chars().flat_map(char::to_lowercase).map(base_letter).collect()
}

/// Root-collation class: whitespace and punctuation, then digits, then letters.
fn class(c: char) -> u8 {
    if c.is_alphabetic() {
        2
    } else if c.is_numeric() {
        1
    } else {
        0
    }
}

/// `Intl.Collator(undefined, { sensitivity: "base", numeric: true })`,
/// near enough for titles: case and accents ignored, digit runs compared by
/// value, punctuation before digits before letters.
pub fn collate(a: &str, b: &str) -> Ordering {
    let (a, b) = (fold(a), fold(b));
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let (ca, cb) = (a[i], b[j]);
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let si = i;
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1;
            }
            let sj = j;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let na: String = a[si..i].iter().collect::<String>().trim_start_matches('0').to_string();
            let nb: String = b[sj..j].iter().collect::<String>().trim_start_matches('0').to_string();
            let ord = na.len().cmp(&nb.len()).then_with(|| na.cmp(&nb));
            if ord != Ordering::Equal {
                return ord;
            }
            continue;
        }
        let ord = class(ca).cmp(&class(cb)).then_with(|| ca.cmp(&cb));
        if ord != Ordering::Equal {
            return ord;
        }
        i += 1;
        j += 1;
    }
    (a.len() - i).cmp(&(b.len() - j))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct T(&'static str, u64, Option<u64>);
    impl SortableTrack for T {
        fn sort_title(&self) -> &str {
            self.0
        }
        fn sort_duration_ms(&self) -> u64 {
            self.1
        }
        fn sort_play_count(&self) -> Option<u64> {
            self.2
        }
    }
    impl Clone for T {
        fn clone(&self) -> T {
            T(self.0, self.1, self.2)
        }
    }

    // shared-helpers.test.ts: track sorting
    #[test]
    fn strips_emoji() {
        assert_eq!(sort_title_key("🔥 Song"), "Song");
        assert_eq!(sort_title_key("🎵🎵"), "🎵🎵");
        assert_eq!(sort_title_key("  A   B "), "A B");
    }

    #[test]
    fn breaks_ties_on_title() {
        let (a, b) = (T("B", 100, Some(5)), T("A", 100, Some(5)));
        assert_eq!(compare_sortable_tracks(&a, &b, SortKey::Duration), Ordering::Greater);
        assert_eq!(compare_sortable_tracks(&a, &b, SortKey::Plays), Ordering::Greater);
        assert_eq!(compare_sortable_tracks(&a, &b, SortKey::Custom), Ordering::Equal);
        let (a, b) = (T("A", 1, None), T("B", 1, Some(3)));
        assert_eq!(compare_sortable_tracks(&a, &b, SortKey::Plays), Ordering::Less);
    }

    #[test]
    fn collates_like_intl() {
        assert_eq!(collate("apple", "Apple"), Ordering::Equal);
        assert_eq!(collate("École", "ecole"), Ordering::Equal);
        assert_eq!(collate("Track 2", "Track 10"), Ordering::Less);
        assert_eq!(collate("b", "A"), Ordering::Greater);
        assert_eq!(collate("(Intro)", "Alpha"), Ordering::Less);
        assert_eq!(collate("9 Lives", "Alpha"), Ordering::Less);
        assert_eq!(collate("Song", "Song 2"), Ordering::Less);
    }

    #[test]
    fn sorts_for_display() {
        let items = vec![T("b", 3, Some(1)), T("🔥 a", 1, Some(9)), T("C", 2, None)];
        let titles = |v: Vec<T>| v.into_iter().map(|t| t.0).collect::<Vec<_>>();
        assert_eq!(titles(sort_for_display(&items, SortKey::Custom, true)), ["b", "🔥 a", "C"]);
        assert_eq!(titles(sort_for_display(&items, SortKey::Title, true)), ["🔥 a", "b", "C"]);
        assert_eq!(titles(sort_for_display(&items, SortKey::Duration, false)), ["b", "C", "🔥 a"]);
        assert_eq!(titles(sort_for_display(&items, SortKey::Plays, SortKey::Plays.default_asc())), ["🔥 a", "b", "C"]);
        assert!(SortKey::Title.default_asc() && !SortKey::Plays.default_asc());
    }
}
