//! cmdk's `command-score` (cmdk 1.1.1): how well a typed abbreviation
//! matches an item's value, from 0 (no match) to 1 (exact). Ported line for
//! line so the palette filters and orders items as the web palette does.

use std::collections::HashMap;

const SCORE_CONTINUE_MATCH: f64 = 1.0;
const SCORE_SPACE_WORD_JUMP: f64 = 0.9;
const SCORE_NON_SPACE_WORD_JUMP: f64 = 0.8;
const SCORE_CHARACTER_JUMP: f64 = 0.17;
const SCORE_TRANSPOSITION: f64 = 0.1;
const PENALTY_SKIPPED: f64 = 0.999;
const PENALTY_CASE_MISMATCH: f64 = 0.9999;
const PENALTY_NOT_COMPLETE: f64 = 0.99;

fn is_gap(c: Option<char>) -> bool {
    matches!(c, Some('\\' | '/' | '_' | '+' | '.' | '#' | '"' | '@' | '[' | '(' | '{' | '&'))
}

fn is_space(c: Option<char>) -> bool {
    matches!(c, Some(c) if c.is_whitespace() || c == '-')
}

struct Ctx<'a> {
    string: &'a [char],
    abbr: &'a [char],
    lower: &'a [char],
    lower_abbr: &'a [char],
    memo: HashMap<(usize, usize), f64>,
}

fn at(s: &[char], i: isize) -> Option<char> {
    if i < 0 { None } else { s.get(i as usize).copied() }
}

fn index_of(s: &[char], c: char, from: usize) -> Option<usize> {
    s.iter().skip(from).position(|&x| x == c).map(|p| p + from)
}

fn score_inner(cx: &mut Ctx, string_index: usize, abbr_index: usize) -> f64 {
    if abbr_index == cx.abbr.len() {
        return if string_index == cx.string.len() { SCORE_CONTINUE_MATCH } else { PENALTY_NOT_COMPLETE };
    }
    if let Some(&v) = cx.memo.get(&(string_index, abbr_index)) {
        return v;
    }
    let abbr_char = cx.lower_abbr[abbr_index];
    let mut index = index_of(cx.lower, abbr_char, string_index);
    let mut high = 0.0f64;
    while let Some(i) = index {
        let mut score = score_inner(cx, i + 1, abbr_index + 1);
        if score > high {
            let before = at(cx.string, i as isize - 1);
            if i == string_index {
                score *= SCORE_CONTINUE_MATCH;
            } else if is_gap(before) {
                score *= SCORE_NON_SPACE_WORD_JUMP;
                let breaks = cx.string[string_index..i.saturating_sub(1).max(string_index)].iter().filter(|&&c| is_gap(Some(c))).count();
                if breaks > 0 && string_index > 0 {
                    score *= PENALTY_SKIPPED.powi(breaks as i32);
                }
            } else if is_space(before) {
                score *= SCORE_SPACE_WORD_JUMP;
                let breaks = cx.string[string_index..i.saturating_sub(1).max(string_index)].iter().filter(|&&c| is_space(Some(c))).count();
                if breaks > 0 && string_index > 0 {
                    score *= PENALTY_SKIPPED.powi(breaks as i32);
                }
            } else {
                score *= SCORE_CHARACTER_JUMP;
                if string_index > 0 {
                    score *= PENALTY_SKIPPED.powi((i - string_index) as i32);
                }
            }
            if cx.string.get(i) != cx.abbr.get(abbr_index) {
                score *= PENALTY_CASE_MISMATCH;
            }
        }
        let next_abbr = at(cx.lower_abbr, abbr_index as isize + 1);
        let prev_lower = at(cx.lower, i as isize - 1);
        if ((score < SCORE_TRANSPOSITION && prev_lower == next_abbr)
            || (next_abbr == Some(abbr_char) && prev_lower != Some(abbr_char)))
            && abbr_index + 2 <= cx.abbr.len()
        {
            let transposed = score_inner(cx, i + 1, abbr_index + 2);
            if transposed * SCORE_TRANSPOSITION > score {
                score = transposed * SCORE_TRANSPOSITION;
            }
        }
        if score > high {
            high = score;
        }
        index = index_of(cx.lower, abbr_char, i + 1);
    }
    cx.memo.insert((string_index, abbr_index), high);
    high
}

/// `formatInput`: lowercased, with whitespace and hyphens as spaces.
fn format_input(s: &[char]) -> Vec<char> {
    s.iter()
        .flat_map(|c| if c.is_whitespace() || *c == '-' { vec![' '] } else { c.to_lowercase().collect() })
        .collect()
}

/// `commandScore(value, search)`.
pub fn command_score(value: &str, search: &str) -> f64 {
    let string: Vec<char> = value.chars().collect();
    let abbr: Vec<char> = search.chars().collect();
    let lower = format_input(&string);
    let lower_abbr = format_input(&abbr);
    // Lowercasing can change a character's length (rare); keep the indexes aligned.
    if lower.len() != string.len() || lower_abbr.len() != abbr.len() {
        let string: Vec<char> = lower.clone();
        let abbr: Vec<char> = lower_abbr.clone();
        let mut cx = Ctx { string: &string, abbr: &abbr, lower: &lower, lower_abbr: &lower_abbr, memo: HashMap::new() };
        return score_inner(&mut cx, 0, 0);
    }
    let mut cx = Ctx { string: &string, abbr: &abbr, lower: &lower, lower_abbr: &lower_abbr, memo: HashMap::new() };
    score_inner(&mut cx, 0, 0)
}

#[cfg(test)]
mod tests {
    use super::command_score;

    #[test]
    fn matches_cmdk() {
        // Values from cmdk 1.1.1's own scorer, run in node.
        let cases: &[(&str, &str, f64)] = &[
            ("navigate Home", "h", 0.8909109000000001),
            ("navigate Home", "zz", 0.0),
            ("navigate Favorites", "fav", 0.8909109000000001),
            ("navigate Playlists", "fav", 0.0),
            ("abc", "abc", 1.0),
            ("action Switch to light mode appearance theme dark light mode", "the", 0.891),
            ("playback Next track skip forward", "nt", 0.80181981),
            ("navigate Pending invites", "pi", 0.80181981),
            ("action Open settings tweaks preferences", "os", 0.80181981),
        ];
        for (value, search, want) in cases {
            let got = command_score(value, search);
            assert!((got - want).abs() < 1e-12, "{value:?} / {search:?}: {got} != {want}");
        }
    }
}
