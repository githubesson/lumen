//! The admin page's own formatting, as an en-US browser shows it in the
//! computer's time zone: `pages/admin/format.ts` (`formatDate`,
//! `formatInterval`) and the date-time columns' `fmtDateTime`. Counts, sizes
//! and plain dates come from `crate::format`, parsing from `core::dates`.
//!
//! These keep an ASCII space before AM/PM, where `format::fmt_date_time`
//! has Chromium's narrow no-break space.

use crate::core::dates::{self, MONTHS_SHORT};

/// `formatInterval`: "60 min", "1.5 hr"; "-" when it isn't a positive time.
pub fn interval(seconds: f64) -> String {
    if !seconds.is_finite() || seconds <= 0.0 {
        return "-".into();
    }
    let minutes = (seconds / 60.0).round();
    if minutes < 60.0 {
        return format!("{minutes} min");
    }
    let hours = (minutes / 60.0 * 10.0).round() / 10.0;
    format!("{hours} hr")
}

fn hour12(h: u32) -> (u32, &'static str) {
    let ampm = if h < 12 { "AM" } else { "PM" };
    let h = h % 12;
    (if h == 0 { 12 } else { h }, ampm)
}

/// `fmtDateTime`: "Oct 11, 2026, 8:12 AM".
pub fn date_time(iso: &str) -> String {
    match dates::parse(iso) {
        Some(ms) => {
            let p = dates::local_parts(ms);
            let (h, ampm) = hour12(p.hour);
            format!("{}, {h}:{:02} {ampm}", dates::medium_date(&p), p.minute)
        }
        None => "Invalid Date".into(),
    }
}

/// The admin tables' `formatDate`: "Oct 11, 06:00 AM"; "-" for none.
pub fn short(iso: Option<&str>) -> String {
    match iso.filter(|s| !s.is_empty()).and_then(dates::parse) {
        Some(ms) => {
            let p = dates::local_parts(ms);
            let (h, ampm) = hour12(p.hour);
            format!("{} {}, {h:02}:{:02} {ampm}", MONTHS_SHORT[p.month as usize - 1], p.day, p.minute)
        }
        None => "-".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intervals() {
        assert_eq!(interval(3540.0), "59 min");
        assert_eq!(interval(3600.0), "1 hr");
        assert_eq!(interval(21_600.0), "6 hr");
        assert_eq!(interval(5400.0), "1.5 hr");
        assert_eq!(interval(0.0), "-");
    }

    #[test]
    fn dates_keep_an_ascii_space() {
        let iso = "2026-10-11T08:12:00Z";
        let p = dates::local_parts(dates::parse(iso).unwrap());
        let (h, ampm) = hour12(p.hour);
        assert_eq!(date_time(iso), format!("{}, {h}:{:02} {ampm}", dates::medium_date(&p), p.minute));
        assert_eq!(short(Some(iso)), format!("{} {}, {h:02}:{:02} {ampm}", MONTHS_SHORT[p.month as usize - 1], p.day, p.minute));
        assert_eq!((hour12(0), hour12(12), hour12(23)), ((12, "AM"), (12, "PM"), (11, "PM")));
        assert_eq!(short(None), "-");
        assert_eq!(short(Some("nope")), "-");
        assert_eq!(date_time("nope"), "Invalid Date");
    }
}
