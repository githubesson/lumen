//! What the web code gets from `Date`: epoch milliseconds, UTC calendar
//! math (`Date.UTC`, `getUTC*`), ISO 8601 parsing (`Date.parse`) and
//! printing (`toISOString`), the local time zone, and the en-US date strings
//! `toLocaleDateString` gives the desktop app.
//!
//! Times are `i64` milliseconds since the Unix epoch, as in JavaScript.

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

pub const MONTHS_SHORT: [&str; 12] =
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
pub const MONTHS_LONG: [&str; 12] = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
    "November", "December",
];
/// By [`Parts::weekday`] (0 = Sunday).
pub const WEEKDAYS_SHORT: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// `Date.now()`.
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (month 1–12).
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date (year, month 1–12, day) `days` after 1970-01-01.
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `Date.UTC(year, month0, day)`: month is 0-based and both it and the day
/// may run over (month 12 is next January, day 0 the last of the month before).
pub fn utc(year: i64, month0: i64, day: i64) -> i64 {
    let y = year + month0.div_euclid(12);
    let m = month0.rem_euclid(12) as u32 + 1;
    (days_from_civil(y, m, 1) + day - 1) * DAY_MS
}

/// A moment's calendar fields (in UTC, or shifted into local time).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Parts {
    pub year: i64,
    /// 1–12.
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub millis: u32,
    /// 0 = Sunday, as `getUTCDay`.
    pub weekday: u32,
}

/// The UTC fields of `ms` (`getUTCFullYear` …).
pub fn utc_parts(ms: i64) -> Parts {
    let days = ms.div_euclid(DAY_MS);
    let rem = ms.rem_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    Parts {
        year,
        month,
        day,
        hour: (rem / 3_600_000) as u32,
        minute: (rem / 60_000 % 60) as u32,
        second: (rem / 1000 % 60) as u32,
        millis: (rem % 1000) as u32,
        weekday: (days + 4).rem_euclid(7) as u32,
    }
}

/// `new Date(year, month0, day, hour)`: a local wall-clock time.
#[cfg(test)]
pub fn local_ms(year: i64, month0: i64, day: i64, hour: i64) -> i64 {
    let wall = utc(year, month0, day) + hour * 3_600_000;
    wall - local_offset_ms(wall - local_offset_ms(wall))
}

/// The local fields of `ms` (`getFullYear` …).
pub fn local_parts(ms: i64) -> Parts {
    utc_parts(ms + local_offset_ms(ms))
}

/// `toISOString`: `2026-11-06T09:30:00.000Z`.
pub fn to_iso(ms: i64) -> String {
    let p = utc_parts(ms);
    let year = if (0..=9999).contains(&p.year) {
        format!("{:04}", p.year)
    } else if p.year < 0 {
        format!("-{:06}", -p.year)
    } else {
        format!("+{:06}", p.year)
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        p.month, p.day, p.hour, p.minute, p.second, p.millis
    )
}

/// `Date.parse` for the ISO 8601 forms the server and inputs use: a date
/// alone (UTC), or a date and time with `Z`, an offset, or neither (local
/// time, as a `datetime-local` value). Fractions of a second may run past
/// milliseconds (Go writes nanoseconds). `None` for anything else.
pub fn parse(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = s.get(from..from + len)?;
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok())?
    };
    // An expanded year (`+010000`, `-000001`), as `toISOString` writes
    // years outside 0–9999.
    let (year, mut at) = match b.first() {
        Some(sign @ (b'+' | b'-')) => {
            let y = num(1, 6)?;
            (if *sign == b'-' { -y } else { y }, 7)
        }
        _ => (num(0, 4)?, 4),
    };
    let (mut month, mut day) = (1, 1);
    if b.get(at) == Some(&b'-') {
        month = num(at + 1, 2)?;
        at += 3;
        if b.get(at) == Some(&b'-') {
            day = num(at + 1, 2)?;
            at += 3;
        }
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month as u32) as i64 {
        return None;
    }
    let date = days_from_civil(year, month as u32, day as u32) * DAY_MS;
    if at == b.len() {
        return Some(date);
    }
    if !matches!(b.get(at), Some(b'T' | b't' | b' ')) {
        return None;
    }
    let hour = num(at + 1, 2)?;
    if b.get(at + 3) != Some(&b':') {
        return None;
    }
    let minute = num(at + 4, 2)?;
    at += 6;
    let mut second = 0;
    let mut millis = 0;
    if b.get(at) == Some(&b':') {
        second = num(at + 1, 2)?;
        at += 3;
        if matches!(b.get(at), Some(b'.' | b',')) {
            at += 1;
            let start = at;
            while b.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
            if at == start {
                return None;
            }
            let digits = &s[start..at.min(start + 3)];
            millis = format!("{digits:0<3}").parse().ok()?;
        }
    }
    if hour > 24 || minute > 59 || second > 59 || (hour == 24 && (minute, second, millis) != (0, 0, 0)) {
        return None;
    }
    let local = date + ((hour * 60 + minute) * 60 + second) * 1000 + millis;
    match b.get(at) {
        None => Some(local - local_offset_ms(local)),
        Some(b'Z' | b'z') if at + 1 == b.len() => Some(local),
        Some(sign @ (b'+' | b'-')) => {
            let oh = num(at + 1, 2)?;
            let rest = &s[at + 3..];
            let om = match rest.strip_prefix(':') {
                Some(m) if m.len() == 2 => m.parse::<i64>().ok()?,
                None if rest.len() == 2 => rest.parse::<i64>().ok()?,
                None if rest.is_empty() => 0,
                _ => return None,
            };
            let offset = (oh * 60 + om) * 60_000;
            Some(if *sign == b'+' { local - offset } else { local + offset })
        }
        _ => None,
    }
}

pub fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

pub fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 31,
    }
}

/// `toLocaleDateString(undefined, { dateStyle: "medium" })` in en-US for
/// the given fields: "Sep 4, 2026".
pub fn medium_date(p: &Parts) -> String {
    format!("{} {}, {}", MONTHS_SHORT[p.month as usize - 1], p.day, p.year)
}

/// The local time zone's offset from UTC at `ms`, in milliseconds (positive
/// east of Greenwich). Zero when the system can't say.
pub fn local_offset_ms(ms: i64) -> i64 {
    sys::offset_secs(ms.div_euclid(1000)).unwrap_or(0) * 1000
}

#[cfg(unix)]
mod sys {
    pub fn offset_secs(secs: i64) -> Option<i64> {
        let t = secs as libc::time_t;
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        // Safety: `localtime_r` only writes `tm`, and is thread-safe.
        let out = unsafe { libc::localtime_r(&t, &mut tm) };
        if out.is_null() { None } else { Some(tm.tm_gmtoff as i64) }
    }
}

#[cfg(windows)]
mod sys {
    #[repr(C)]
    #[allow(non_snake_case)]
    struct SystemTime {
        wYear: u16,
        wMonth: u16,
        wDayOfWeek: u16,
        wDay: u16,
        wHour: u16,
        wMinute: u16,
        wSecond: u16,
        wMilliseconds: u16,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SystemTimeToTzSpecificLocalTime(
            tz: *const std::ffi::c_void,
            utc: *const SystemTime,
            local: *mut SystemTime,
        ) -> i32;
    }

    pub fn offset_secs(secs: i64) -> Option<i64> {
        let p = super::utc_parts(secs * 1000);
        if !(1601..=30827).contains(&p.year) {
            return None;
        }
        let utc = SystemTime {
            wYear: p.year as u16,
            wMonth: p.month as u16,
            wDayOfWeek: 0,
            wDay: p.day as u16,
            wHour: p.hour as u16,
            wMinute: p.minute as u16,
            wSecond: p.second as u16,
            wMilliseconds: 0,
        };
        let mut local = std::mem::MaybeUninit::<SystemTime>::uninit();
        // Safety: a null zone means the system's; `local` is read only on success.
        let ok = unsafe { SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, local.as_mut_ptr()) };
        if ok == 0 {
            return None;
        }
        let l = unsafe { local.assume_init() };
        let local_secs = super::days_from_civil(l.wYear as i64, l.wMonth as u32, l.wDay as u32) * 86_400
            + l.wHour as i64 * 3600
            + l.wMinute as i64 * 60
            + l.wSecond as i64;
        Some(local_secs - secs)
    }
}

#[cfg(not(any(unix, windows)))]
mod sys {
    pub fn offset_secs(_secs: i64) -> Option<i64> {
        None
    }
}

/// A local date and time as a person types it where the web has a
/// `datetime-local` field (`new Date(text)` reads these as local time too):
/// `2026-11-20T09:30`, `11/20/2026, 9:30 AM`, `11/20/2026 21:30`. A date
/// needs its time here; `None` for anything else.
pub fn parse_local_input(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, time) = match s.find(['T', ' ', ',']) {
        Some(at) => (&s[..at], s[at + 1..].trim_start_matches([',', ' '])),
        None => (s, ""),
    };
    let (year, month, day) = if date.contains('-') {
        let p: Vec<&str> = date.split('-').collect();
        (p.first()?.parse::<i64>().ok()?, p.get(1)?.parse::<u32>().ok()?, p.get(2)?.parse::<u32>().ok()?)
    } else {
        let p: Vec<&str> = date.split('/').collect();
        (p.get(2)?.parse::<i64>().ok()?, p.first()?.parse::<u32>().ok()?, p.get(1)?.parse::<u32>().ok()?)
    };
    let time = time.trim();
    let (clock, pm) = match time.to_ascii_uppercase() {
        t if t.ends_with("PM") => (time[..time.len() - 2].trim(), Some(true)),
        t if t.ends_with("AM") => (time[..time.len() - 2].trim(), Some(false)),
        _ => (time, None),
    };
    let (h, m) = clock.split_once(':')?;
    let (mut hour, minute) = (h.trim().parse::<u32>().ok()?, m.trim().parse::<u32>().ok()?);
    match pm {
        Some(pm) if (1..=12).contains(&hour) => hour = hour % 12 + if pm { 12 } else { 0 },
        Some(_) => return None,
        None => {}
    }
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) || hour > 23 || minute > 59 {
        return None;
    }
    if !(1..=275_760).contains(&year) {
        return None;
    }
    let wall = days_from_civil(year, month, day) * DAY_MS + (hour as i64 * 60 + minute as i64) * 60_000;
    Some(wall - local_offset_ms(wall - local_offset_ms(wall)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trips() {
        for days in [-800_000, -1, 0, 1, 365, 10_957, 20_000, 2_932_896] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(utc(2026, 0, 1), parse("2026-01-01T00:00:00Z").unwrap());
        assert_eq!(utc(2026, 12, 1), utc(2027, 0, 1));
        assert_eq!(utc(2026, 2, 0), utc(2026, 1, 28));
    }

    #[test]
    fn iso_round_trips() {
        let ms = parse("2026-11-06T09:30:15.250Z").unwrap();
        assert_eq!(to_iso(ms), "2026-11-06T09:30:15.250Z");
        assert_eq!(parse("2026-11-06T10:30:15.250+01:00"), Some(ms));
        assert_eq!(parse("2026-11-06T09:30:15.250123456Z"), Some(ms));
        assert_eq!(parse("2026-11-06"), Some(utc(2026, 10, 6)));
        assert_eq!(parse("1969-12-31T23:59:59.999Z"), Some(-1));
        assert_eq!(to_iso(-1), "1969-12-31T23:59:59.999Z");
        assert_eq!(utc_parts(0).weekday, 4);
        let far = parse("+010000-01-01T00:00:00.000Z").unwrap();
        assert_eq!((utc_parts(far).year, to_iso(far).as_str()), (10000, "+010000-01-01T00:00:00.000Z"));
        for bad in ["", "soon", "2026-13-01", "2026-02-30", "2026-01-01T25:00Z", "2026-01-01Tx"] {
            assert_eq!(parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn local_time_is_consistent() {
        let ms = parse("2026-07-01T12:00:00Z").unwrap();
        let p = local_parts(ms);
        let back = utc(p.year, p.month as i64 - 1, p.day as i64)
            + ((p.hour as i64 * 60 + p.minute as i64) * 60 + p.second as i64) * 1000;
        assert_eq!(back - local_offset_ms(ms), ms);
        // A wall-clock time without an offset reads as local time.
        let wall = format!("{:04}-{:02}-{:02}T{:02}:{:02}", p.year, p.month, p.day, p.hour, p.minute);
        assert_eq!(parse(&wall), Some(ms));
    }

    #[test]
    fn typed_local_dates() {
        let at = local_ms(2026, 10, 20, 21) + 30 * 60_000;
        assert_eq!(parse_local_input("11/20/2026, 9:30 PM"), Some(at));
        assert_eq!(parse_local_input("11/20/2026 21:30"), Some(at));
        assert_eq!(parse_local_input("2026-11-20T21:30"), Some(at));
        assert_eq!(parse_local_input("11/20/2026, 12:05 AM"), Some(local_ms(2026, 10, 20, 0) + 5 * 60_000));
        for bad in ["", "soon", "11/20/2026", "02/30/2026, 9:30 AM", "11/20/2026, 13:00 PM", "11/20/2026, 9:60"] {
            assert_eq!(parse_local_input(bad), None, "{bad}");
        }
    }

    #[test]
    fn en_us_strings() {
        let p = utc_parts(parse("2026-09-04T15:45:00Z").unwrap());
        assert_eq!(medium_date(&p), "Sep 4, 2026");
    }
}
