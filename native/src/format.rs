//! `core/src/format.ts` and the web's `lib/format.ts` / `lib/text.ts`:
//! display formatters shared by every page.
//!
//! The `fmt_*` names follow `lib/format.ts`; `format_*` follow core. Dates
//! read in en-US, the locale the desktop app runs its `toLocale*` calls in.

use crate::core::dates;

/// `formatDurationSec`: `m:ss` (minutes run past 60); "0:00" for NaN,
/// infinite or negative input.
pub fn fmt_duration_sec(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "0:00".into();
    }
    let total = seconds.floor() as u64;
    format!("{}:{:02}", total / 60, total % 60)
}

/// `formatDurationMs` with its empty label (shown for zero).
pub fn fmt_duration_ms_or(ms: u64, empty: &str) -> String {
    if ms == 0 { empty.to_string() } else { fmt_duration_sec(ms as f64 / 1000.0) }
}

/// `fmtDurationMs` ("0:00" when empty).
pub fn fmt_duration_ms(ms: u64) -> String {
    fmt_duration_ms_or(ms, "0:00")
}

/// `formatDurationMs(ms, emptyLabel)` for a value that may be missing or
/// not a number.
pub fn format_duration_ms(ms: Option<f64>, empty: &str) -> String {
    match ms {
        Some(ms) if ms.is_finite() && ms > 0.0 => fmt_duration_sec(ms / 1000.0),
        _ => empty.to_string(),
    }
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

/// `formatBytes`: "4.2 MB", whole numbers for bytes and for values of 100
/// and up; "—" for nothing.
pub fn fmt_bytes(bytes: f64) -> String {
    if !bytes.is_finite() || bytes <= 0.0 {
        return "—".into();
    }
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut i = 0;
    let mut v = bytes;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    let digits = if i == 0 || v >= 100.0 { 0 } else { 1 };
    format!("{} {}", to_fixed(v, digits), UNITS[i])
}

/// `formatSampleRate`: "44.1 kHz" / "48 kHz"; "—" when unknown.
pub fn format_sample_rate(hz: Option<f64>) -> String {
    match hz {
        Some(hz) if hz.is_finite() && hz > 0.0 => {
            let fixed = to_fixed(hz / 1000.0, 1);
            let trimmed = fixed.strip_suffix(".0").unwrap_or(&fixed);
            format!("{trimmed} kHz")
        }
        _ => "—".into(),
    }
}

/// `formatBitrate`: "320 kbps"; "—" when unknown.
pub fn format_bitrate(bps: Option<f64>) -> String {
    match bps {
        Some(bps) if bps.is_finite() && bps > 0.0 => format!("{} kbps", js_round(bps / 1000.0)),
        _ => "—".into(),
    }
}

/// `formatCalendarDate`: a `YYYY-MM-DD` day ("Mar 17, 2023"), read as a
/// calendar day so no time zone moves it; "—" when it isn't one.
pub fn format_calendar_date(date: Option<&str>) -> String {
    let s = date.unwrap_or("").trim();
    let b = s.as_bytes();
    let ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if !ok {
        return "—".into();
    }
    let (y, m, d): (i64, u32, u32) =
        (s[0..4].parse().unwrap_or(0), s[5..7].parse().unwrap_or(0), s[8..10].parse().unwrap_or(0));
    if !(1..=12).contains(&m) || d == 0 || d > dates::days_in_month(y, m) {
        return "—".into();
    }
    dates::medium_date(&dates::utc_parts(dates::utc(y, m as i64 - 1, d as i64)))
}

/// `fmtDate`: "Sep 4, 2026" in local time; "Invalid Date" for text that
/// isn't a date, as `Date` prints it.
pub fn fmt_date(iso: &str) -> String {
    match dates::parse(iso) {
        Some(ms) => dates::medium_date(&dates::local_parts(ms)),
        None => "Invalid Date".into(),
    }
}

/// `pluralize`: "1 track" / "2 tracks".
pub fn pluralize(n: u64, singular: &str) -> String {
    pluralize_with(n, singular, None)
}

/// `pluralize` with an irregular plural.
pub fn pluralize_with(n: u64, singular: &str, plural: Option<&str>) -> String {
    let word = if n == 1 { singular.to_string() } else { plural.map_or_else(|| format!("{singular}s"), str::to_string) };
    format!("{n} {word}")
}

/// `pluralize(n, singular, undefined, { locale: true })`: "1,234 plays".
pub fn pluralize_grouped(n: u64, singular: &str) -> String {
    let word = if n == 1 { singular.to_string() } else { format!("{singular}s") };
    format!("{} {word}", group_thousands(n))
}

/// `n.toLocaleString()` in en-US for a whole number: "1,234,567".
pub fn group_thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `displayText` (core): mojibake (double-encoded UTF-8) cleaned up and
/// trimmed; "" for nothing.
pub fn clean_text(value: Option<&str>) -> String {
    let Some(v) = value else { return String::new() };
    if !v.contains(['Â', 'Ã']) {
        return v.trim().to_string();
    }
    v.replace("Ã\u{0082}Â·", "·")
        .replace("Â·", "·")
        .replace("Ã¢â\u{0082}¬â€œ", "—")
        .replace("Ã\u{0085}Â\u{0081}", "L")
        .replace("Ã\u{0084}", "")
        .replace('Â', "")
        .replace('Ã', "")
        .trim()
        .to_string()
}

/// `displayText(value) || fallback`: cleaned text, or the fallback when
/// there's none (missing, blank, or nothing left after cleaning).
pub fn display_text(s: Option<&str>, fallback: &str) -> String {
    let cleaned = clean_text(s);
    if cleaned.is_empty() { fallback.to_string() } else { cleaned }
}

/// core's `displayText(value, fallback)` itself: the fallback stands in only
/// for a missing value (`??`); an empty one stays empty. Compare
/// [`display_text`], the `displayText(value) || fallback` most views use.
pub fn display_text_nullish(value: Option<&str>, fallback: &str) -> String {
    clean_text(Some(value.unwrap_or(fallback)))
}

/// `Math.round`: halves round up (towards +∞).
pub fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// `Number.prototype.toFixed`: `digits` decimals, a tie between two
/// candidates going to the larger, judged on the number's exact value.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() {
        return if x.is_nan() { "NaN".into() } else if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let negative = x < 0.0;
    // Enough digits to hold a double's exact binary value.
    let exact = format!("{:.1100}", x.abs());
    let (int, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut kept: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).collect();
    if frac.as_bytes().get(digits).is_some_and(|d| *d >= b'5') {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let split = kept.len() - digits;
    let mut out = String::from_utf8(kept[..split].to_vec()).unwrap_or_default();
    if digits > 0 {
        out.push('.');
        out.push_str(std::str::from_utf8(&kept[split..]).unwrap_or(""));
    }
    if negative { format!("-{out}") } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(fmt_duration_sec(65.9), "1:05");
        assert_eq!(fmt_duration_sec(f64::NAN), "0:00");
        assert_eq!(fmt_duration_sec(-1.0), "0:00");
        assert_eq!(fmt_duration_sec(3725.0), "62:05");
        assert_eq!(format_duration_ms(None, "—"), "—");
        assert_eq!(format_duration_ms(Some(0.0), "—"), "—");
        assert_eq!(format_duration_ms(Some(f64::NAN), ""), "");
        assert_eq!(format_duration_ms(Some(61_000.0), "—"), "1:01");
        assert_eq!(fmt_total_ms(12 * 60_000), "12 min");
        assert_eq!(fmt_total_ms(83 * 60_000), "1 hr 23 min");
    }

    // shared-helpers.test.ts: formatBytes
    #[test]
    fn bytes_scale_through_tb() {
        assert_eq!(fmt_bytes(50.0), "50 B");
        assert_eq!(fmt_bytes(1536.0), "1.5 KB");
        assert_eq!(fmt_bytes(150.0 * 1024f64.powi(3)), "150 GB");
        assert_eq!(fmt_bytes(1.5 * 1024f64.powi(4)), "1.5 TB");
        assert_eq!(fmt_bytes(0.0), "—");
        assert_eq!(fmt_bytes(146.5 * 1024.0), "147 KB");
    }

    #[test]
    fn rates() {
        assert_eq!(format_sample_rate(Some(44_100.0)), "44.1 kHz");
        assert_eq!(format_sample_rate(Some(48_000.0)), "48 kHz");
        assert_eq!(format_sample_rate(None), "—");
        assert_eq!(format_bitrate(Some(320_000.0)), "320 kbps");
        assert_eq!(format_bitrate(Some(127_500.0)), "128 kbps");
        assert_eq!(format_bitrate(Some(0.0)), "—");
    }

    #[test]
    fn calendar_dates() {
        assert_eq!(format_calendar_date(Some("2023-03-17")), "Mar 17, 2023");
        assert_eq!(format_calendar_date(Some(" 2024-02-29 ")), "Feb 29, 2024");
        assert_eq!(format_calendar_date(Some("2023-02-29")), "—");
        assert_eq!(format_calendar_date(Some("2023-3-17")), "—");
        assert_eq!(format_calendar_date(None), "—");
    }

    #[test]
    fn local_dates() {
        assert_eq!(fmt_date("not a date"), "Invalid Date");
    }

    #[test]
    fn plurals() {
        assert_eq!(pluralize(1, "track"), "1 track");
        assert_eq!(pluralize(2, "track"), "2 tracks");
        assert_eq!(pluralize_with(2, "child", Some("children")), "2 children");
        assert_eq!(pluralize_grouped(1234, "play"), "1,234 plays");
        assert_eq!(group_thousands(1_234_567), "1,234,567");
        assert_eq!(group_thousands(999), "999");
    }

    // shared-helpers.test.ts: displayText
    #[test]
    fn display_text_repairs_mojibake() {
        assert_eq!(clean_text(Some("A \u{00c2}\u{00b7} B")), "A \u{00b7} B");
        assert_eq!(
            clean_text(Some("Live \u{00c3}\u{00a2}\u{00e2}\u{0082}\u{00ac}\u{00e2}\u{20ac}\u{0153} 2019")),
            "Live \u{2014} 2019"
        );
        assert_eq!(display_text(None, "Unknown"), "Unknown");
        assert_eq!(clean_text(Some("  Title  ")), "Title");
        assert_eq!(display_text(Some("   "), "—"), "—");
    }

    #[test]
    fn to_fixed_matches_js() {
        assert_eq!(to_fixed(1.25, 1), "1.3");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(0.5, 0), "1");
        assert_eq!(to_fixed(99.96, 1), "100.0");
        assert_eq!(to_fixed(-0.04, 1), "-0.0");
        assert_eq!(to_fixed(-0.0, 1), "0.0");
        assert_eq!(to_fixed(44.1, 1), "44.1");
        assert_eq!(js_round(2.5), 3);
        assert_eq!(js_round(-2.5), -2);
    }
}
