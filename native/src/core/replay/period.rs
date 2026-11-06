//! `core/src/replay/period.ts`: the time window Replay aggregates over.
//! Boundaries are UTC midnights (the server stores plays in UTC); which
//! year and month "this" one is follows the local clock, as on the web.

use crate::api::stats::ReplayBucket;
use crate::core::dates::{self, DAY_MS, MONTHS_LONG};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Period {
    All,
    ThisYear,
    Year(i32),
    ThisMonth,
    Last30,
}

/// `periodKey`: stable, for caches and `?period=`.
pub fn period_key(p: Period) -> String {
    match p {
        Period::All => "all".into(),
        Period::ThisYear => "this-year".into(),
        Period::Year(y) => format!("year:{y}"),
        Period::ThisMonth => "this-month".into(),
        Period::Last30 => "last-30".into(),
    }
}

/// `parsePeriodKey`: the period a key names, or `None`.
pub fn parse_period_key(key: Option<&str>) -> Option<Period> {
    match key? {
        "all" => Some(Period::All),
        "this-year" => Some(Period::ThisYear),
        "this-month" => Some(Period::ThisMonth),
        "last-30" => Some(Period::Last30),
        k => {
            let y = k.strip_prefix("year:")?;
            (y.len() == 4 && y.bytes().all(|b| b.is_ascii_digit())).then(|| Period::Year(y.parse().unwrap_or(0)))
        }
    }
}

/// `canonicalPeriodKey`: the one spelling of a `?period=` value, or `None`
/// for the default (this year), which also stands in for anything with no
/// pill: not a period, the current year by number, or a year with no plays
/// once `available_years` is known.
pub fn canonical_period_key(param: Option<&str>, available_years: Option<&[i32]>, current_year: i32) -> Option<String> {
    let period = parse_period_key(param)?;
    match period {
        Period::ThisYear => None,
        Period::Year(y) if y == current_year => None,
        Period::Year(y) if available_years.is_some_and(|ys| !ys.contains(&y)) => None,
        p => Some(period_key(p)),
    }
}

/// The local calendar year now.
pub fn current_year(now_ms: i64) -> i32 {
    dates::local_parts(now_ms).year as i32
}

/// `periodLabel`: the picker chip.
pub fn period_label(p: Period) -> String {
    match p {
        Period::All => "All time".into(),
        Period::ThisYear => "This year".into(),
        Period::Year(y) => y.to_string(),
        Period::ThisMonth => "This month".into(),
        Period::Last30 => "Last 30 days".into(),
    }
}

/// `periodTitle`: the hero, playlist names and share images.
pub fn period_title(p: Period, now_ms: i64) -> String {
    let local = dates::local_parts(now_ms);
    match p {
        Period::All => "All time".into(),
        Period::ThisYear => format!("This year · {}", local.year),
        Period::Year(y) => y.to_string(),
        Period::ThisMonth => format!("{} {}", MONTHS_LONG[local.month as usize - 1], local.year),
        Period::Last30 => "Last 30 days".into(),
    }
}

/// A period's API range and activity bucket.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ReplayRange {
    pub from: Option<String>,
    pub to: Option<String>,
    pub bucket: Option<ReplayBucket>,
}

/// `periodRange`.
pub fn period_range(p: Period, now_ms: i64) -> ReplayRange {
    let local = dates::local_parts(now_ms);
    let (y, m0) = (local.year, local.month as i64 - 1);
    let span = |from: i64, to: i64, bucket| ReplayRange {
        from: Some(dates::to_iso(from)),
        to: Some(dates::to_iso(to)),
        bucket: Some(bucket),
    };
    match p {
        Period::All => ReplayRange { bucket: Some(ReplayBucket::Month), ..Default::default() },
        Period::ThisYear => span(dates::utc(y, 0, 1), dates::utc(y + 1, 0, 1), ReplayBucket::Month),
        Period::Year(year) => span(dates::utc(year as i64, 0, 1), dates::utc(year as i64 + 1, 0, 1), ReplayBucket::Month),
        Period::ThisMonth => span(dates::utc(y, m0, 1), dates::utc(y, m0 + 1, 1), ReplayBucket::Day),
        Period::Last30 => span(now_ms - 30 * DAY_MS, now_ms, ReplayBucket::Day),
    }
}

/// `buildPeriodOptions`: the evergreen windows, past years with plays, all time.
pub fn build_period_options(available_years: &[i32], current_year: i32) -> Vec<Period> {
    let mut out = vec![Period::ThisYear, Period::Last30, Period::ThisMonth];
    out.extend(available_years.iter().filter(|y| **y != current_year).map(|y| Period::Year(*y)));
    out.push(Period::All);
    out
}

/// How verbosely to spell a listening total: the phone's tiles want "45m",
/// the web has room for "45 min".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ListeningTimeStyle {
    #[default]
    Compact,
    Verbose,
}

/// `formatListeningTime`: "2d 4h" / "3h 12m" / "45m".
pub fn format_listening_time(ms: i64, style: ListeningTimeStyle) -> String {
    let verbose = style == ListeningTimeStyle::Verbose;
    if ms <= 0 {
        return if verbose { "0 min".into() } else { "0m".into() };
    }
    let total = ms / 60_000;
    let days = total / (60 * 24);
    let hours = (total - days * 60 * 24) / 60;
    let minutes = total - days * 60 * 24 - hours * 60;
    if days >= 1 {
        if hours > 0 {
            return format!("{days}d {hours}h");
        }
        return if verbose { format!("{days} {}", if days == 1 { "day" } else { "days" }) } else { format!("{days}d") };
    }
    if hours >= 1 {
        return if minutes > 0 { format!("{hours}h {minutes}m") } else { format!("{hours}h") };
    }
    if verbose { format!("{minutes} min") } else { format!("{minutes}m") }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> i64 {
        dates::now_ms()
    }

    // shared-helpers.test.ts: replay periods
    #[test]
    fn utc_boundaries() {
        let r = period_range(Period::Year(2019), now());
        assert_eq!(r.from.as_deref(), Some("2019-01-01T00:00:00.000Z"));
        assert_eq!(r.to.as_deref(), Some("2020-01-01T00:00:00.000Z"));
        assert_eq!(r.bucket, Some(ReplayBucket::Month));
        assert_eq!(period_range(Period::ThisMonth, now()).bucket, Some(ReplayBucket::Day));
        assert_eq!(period_range(Period::Last30, now()).bucket, Some(ReplayBucket::Day));
        assert_eq!(period_range(Period::All, now()), ReplayRange { bucket: Some(ReplayBucket::Month), ..Default::default() });
        assert_eq!(period_key(Period::Year(2020)), "year:2020");
        assert_eq!(period_key(Period::All), "all");
    }

    #[test]
    fn options_skip_the_current_year() {
        let y = current_year(now());
        let options = build_period_options(&[y, y - 1], y);
        let years: Vec<Period> = options.iter().copied().filter(|p| matches!(p, Period::Year(_))).collect();
        assert_eq!(years, [Period::Year(y - 1)]);
        assert_eq!(options.last(), Some(&Period::All));
    }

    #[test]
    fn listening_times() {
        use ListeningTimeStyle::*;
        for style in [Compact, Verbose] {
            assert_eq!(format_listening_time(25 * 3_600_000, style), "1d 1h");
            assert_eq!(format_listening_time(90 * 60_000, style), "1h 30m");
            assert_eq!(format_listening_time(60 * 60_000, style), "1h");
        }
        assert_eq!(format_listening_time(45 * 60_000, Compact), "45m");
        assert_eq!(format_listening_time(45 * 60_000, Verbose), "45 min");
        assert_eq!(format_listening_time(48 * 3_600_000, Compact), "2d");
        assert_eq!(format_listening_time(48 * 3_600_000, Verbose), "2 days");
        assert_eq!(format_listening_time(24 * 3_600_000, Verbose), "1 day");
        assert_eq!(format_listening_time(0, Compact), "0m");
        assert_eq!(format_listening_time(-1, Verbose), "0 min");
    }

    // replay.test.ts: parsePeriodKey, canonicalPeriodKey
    #[test]
    fn period_keys_round_trip() {
        for p in [Period::All, Period::ThisYear, Period::ThisMonth, Period::Last30, Period::Year(2024)] {
            assert_eq!(parse_period_key(Some(&period_key(p))), Some(p));
        }
        for k in [None, Some(""), Some("last-7"), Some("year:"), Some("year:24"), Some("year:2024x")] {
            assert_eq!(parse_period_key(k), None, "{k:?}");
        }
    }

    #[test]
    fn canonical_keys() {
        assert_eq!(canonical_period_key(Some("last-30"), Some(&[2025]), 2026).as_deref(), Some("last-30"));
        assert_eq!(canonical_period_key(Some("all"), Some(&[]), 2026).as_deref(), Some("all"));
        assert_eq!(canonical_period_key(Some("year:2025"), Some(&[2025, 2026]), 2026).as_deref(), Some("year:2025"));
        assert_eq!(canonical_period_key(None, Some(&[2025]), 2026), None);
        assert_eq!(canonical_period_key(Some("this-year"), Some(&[2025]), 2026), None);
        assert_eq!(canonical_period_key(Some("year:2026"), Some(&[2025, 2026]), 2026), None);
        assert_eq!(canonical_period_key(Some("bogus"), Some(&[2025]), 2026), None);
        assert_eq!(canonical_period_key(Some("year:1999"), Some(&[2025]), 2026), None);
        assert_eq!(canonical_period_key(Some("year:1999"), None, 2026).as_deref(), Some("year:1999"));
    }

    #[test]
    fn titles() {
        let mid_june = dates::utc(2026, 5, 15) + 12 * 3_600_000;
        assert_eq!(period_title(Period::ThisMonth, mid_june), "June 2026");
        assert_eq!(period_title(Period::ThisYear, mid_june), "This year · 2026");
        assert_eq!(period_title(Period::Year(2025), mid_june), "2025");
        assert_eq!(period_label(Period::Last30), "Last 30 days");
    }
}
