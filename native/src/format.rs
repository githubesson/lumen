//! `lib/format.ts` and `core/src/format.ts`.
#![allow(dead_code)]

/// `formatDurationSec`: `m:ss` (minutes run past 60).
pub fn fmt_duration_sec(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "0:00".into();
    }
    let total = seconds.floor() as u64;
    format!("{}:{:02}", total / 60, total % 60)
}

/// `formatDurationMs` with its empty label.
pub fn fmt_duration_ms_or(ms: u64, empty: &str) -> String {
    if ms == 0 { empty.to_string() } else { fmt_duration_sec(ms as f64 / 1000.0) }
}

/// `fmtDurationMs` ("0:00" when empty).
pub fn fmt_duration_ms(ms: u64) -> String {
    fmt_duration_ms_or(ms, "0:00")
}

/// `formatTotalMs`: "12 min" / "1 hr 23 min".
pub fn fmt_total_ms(total_ms: u64) -> String {
    let mins = total_ms / 60000;
    if mins < 60 {
        return format!("{mins} min");
    }
    let (h, m) = (mins / 60, mins % 60);
    format!("{h} hr {m} min")
}

/// `pluralize(n, singular)`: "1 track", "8 tracks".
pub fn pluralize(n: usize, singular: &str) -> String {
    if n == 1 { format!("1 {singular}") } else { format!("{n} {singular}s") }
}

/// `displayText`: trimmed text, or the fallback when there's none.
pub fn display_text(s: Option<&str>, fallback: &str) -> String {
    match s.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s.to_string(),
        None => fallback.to_string(),
    }
}
