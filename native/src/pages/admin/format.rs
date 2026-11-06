//! The admin page's formatting: `pages/admin/format.ts` (`formatDate`,
//! `formatInterval`), `lib/format.ts`'s `fmtDate`/`fmtDateTime`, core's
//! `formatBytes` and `pluralize`, and `toLocaleString` for counts, as an
//! en-US browser shows them, in the computer's time zone.
//!
//! The date helpers belong in `crate::format` once it reads dates; they live
//! here until then.

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// `n.toLocaleString()`: "18,442".
pub fn int(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// `pluralize(n, singular)`: "1 user", "4 users".
pub fn pluralize(n: u64, singular: &str) -> String {
    if n == 1 { format!("1 {singular}") } else { format!("{n} {singular}s") }
}

/// `formatBytes`: "571 GB", "39.1 GB"; "—" for nothing.
pub fn bytes(n: u64) -> String {
    if n == 0 {
        return "—".into();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut i = 0;
    let mut v = n as f64;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 || v >= 100.0 { format!("{} {}", js_fixed(v, 0), units[i]) } else { format!("{} {}", js_fixed(v, 1), units[i]) }
}

/// `Number.prototype.toFixed`: rounds half away from zero on the decimal value.
fn js_fixed(v: f64, digits: usize) -> String {
    let p = 10f64.powi(digits as i32);
    let r = (v * p).round() / p;
    format!("{r:.digits$}")
}

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

/// A moment as the computer's clock shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Civil {
    pub year: i64,
    /// 1–12.
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
}

/// `new Date(iso)` for the ISO 8601 forms the server sends: Unix
/// milliseconds, or None for an invalid date.
pub fn parse_iso(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = s.get(r)?;
        if part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    if !(1..=12).contains(&mo) || d < 1 || d > days_in_month(y, mo as u32) as i64 {
        return None;
    }
    let days = days_from_civil(y, mo as u32, d as u32);
    if b.len() == 10 {
        // A date alone is UTC midnight.
        return Some(days * 86_400_000);
    }
    if b[10] != b'T' && b[10] != b't' && b[10] != b' ' {
        return None;
    }
    let (h, mi) = (num(11..13)?, num(14..16)?);
    if b.get(13) != Some(&b':') || h > 23 || mi > 59 {
        return None;
    }
    let mut i = 16;
    let mut sec = 0;
    let mut ms = 0;
    if b.get(i) == Some(&b':') {
        sec = num(i + 1..i + 3)?;
        i += 3;
        if b.get(i) == Some(&b'.') {
            let start = i + 1;
            let mut end = start;
            while end < b.len() && b[end].is_ascii_digit() {
                end += 1;
            }
            let frac = s.get(start..end)?;
            let frac3: String = frac.chars().chain("000".chars()).take(3).collect();
            ms = frac3.parse::<i64>().ok()?;
            i = end;
        }
    }
    let local = days * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1000 + ms;
    match s.get(i..) {
        // Date-time forms without an offset are local time.
        Some("") => Some(local_to_utc(local)),
        Some("Z" | "z") => Some(local),
        Some(off) if off.len() == 6 && (off.starts_with('+') || off.starts_with('-')) && &off[3..4] == ":" => {
            let oh: i64 = off[1..3].parse().ok()?;
            let om: i64 = off[4..6].parse().ok()?;
            let sign = if off.starts_with('-') { -1 } else { 1 };
            Some(local - sign * (oh * 3_600_000 + om * 60_000))
        }
        _ => None,
    }
}

/// `date.toISOString()`.
pub fn to_iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

/// The moment in the computer's time zone.
pub fn local(ms: i64) -> Civil {
    let shifted = ms + local_offset_ms(ms);
    let days = shifted.div_euclid(86_400_000);
    let rem = shifted.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    Civil { year, month, day, hour: (rem / 3_600_000) as u32, minute: (rem / 60_000 % 60) as u32 }
}

/// A local wall-clock time (as Unix ms if it were UTC) to the real instant.
pub fn local_to_utc(wall: i64) -> i64 {
    let guess = wall - local_offset_ms(wall);
    wall - local_offset_ms(guess)
}

fn hour12(h: u32) -> (u32, &'static str) {
    let ampm = if h < 12 { "AM" } else { "PM" };
    let h = h % 12;
    (if h == 0 { 12 } else { h }, ampm)
}

/// `fmtDate`: "Oct 11, 2026".
pub fn date(iso: &str) -> String {
    match parse_iso(iso) {
        Some(ms) => {
            let c = local(ms);
            format!("{} {}, {}", MONTHS[c.month as usize - 1], c.day, c.year)
        }
        None => "Invalid Date".into(),
    }
}

/// `fmtDateTime`: "Oct 11, 2026, 8:12 AM".
pub fn date_time(iso: &str) -> String {
    match parse_iso(iso) {
        Some(ms) => {
            let c = local(ms);
            let (h, ampm) = hour12(c.hour);
            format!("{} {}, {}, {h}:{:02} {ampm}", MONTHS[c.month as usize - 1], c.day, c.year, c.minute)
        }
        None => "Invalid Date".into(),
    }
}

/// The admin tables' `formatDate`: "Oct 11, 06:00 AM"; "-" for none.
pub fn short(iso: Option<&str>) -> String {
    match iso.filter(|s| !s.is_empty()).and_then(parse_iso) {
        Some(ms) => {
            let c = local(ms);
            let (h, ampm) = hour12(c.hour);
            format!("{} {}, {h:02}:{:02} {ampm}", MONTHS[c.month as usize - 1], c.day, c.minute)
        }
        None => "-".into(),
    }
}

/// Now, in Unix milliseconds.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        2 if is_leap(y) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm).
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The computer's UTC offset at `ms`, daylight saving included.
#[cfg(all(unix, target_pointer_width = "64"))]
fn local_offset_ms(ms: i64) -> i64 {
    #[repr(C)]
    struct Tm {
        sec: i32,
        min: i32,
        hour: i32,
        mday: i32,
        mon: i32,
        year: i32,
        wday: i32,
        yday: i32,
        isdst: i32,
        gmtoff: std::ffi::c_long,
        zone: *const std::ffi::c_char,
    }
    unsafe extern "C" {
        fn localtime_r(t: *const i64, out: *mut Tm) -> *mut Tm;
    }
    let t = ms.div_euclid(1000);
    let mut tm = std::mem::MaybeUninit::<Tm>::zeroed();
    // SAFETY: `localtime_r` writes a `struct tm` (this layout on 64-bit glibc
    // and macOS) into `tm` and reads only `t`.
    let ok = unsafe { !localtime_r(&t, tm.as_mut_ptr()).is_null() };
    if ok { unsafe { tm.assume_init() }.gmtoff as i64 * 1000 } else { 0 }
}

/// The computer's UTC offset at `ms`, daylight saving included.
#[cfg(windows)]
fn local_offset_ms(ms: i64) -> i64 {
    #[repr(C)]
    #[derive(Default)]
    struct SystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        millis: u16,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SystemTimeToTzSpecificLocalTime(tz: *const std::ffi::c_void, utc: *const SystemTime, local: *mut SystemTime) -> i32;
    }
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    if !(1601..=30827).contains(&y) {
        return 0;
    }
    let utc = SystemTime {
        year: y as u16,
        month: m as u16,
        day: d as u16,
        hour: (rem / 3_600_000) as u16,
        minute: (rem / 60_000 % 60) as u16,
        second: (rem / 1000 % 60) as u16,
        ..Default::default()
    };
    let mut out = SystemTime::default();
    // SAFETY: both pointers are valid SYSTEMTIMEs; a null zone means the
    // computer's current one.
    if unsafe { SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut out) } == 0 {
        return 0;
    }
    let local = days_from_civil(out.year as i64, out.month as u32, out.day as u32) * 86_400_000
        + out.hour as i64 * 3_600_000
        + out.minute as i64 * 60_000
        + out.second as i64 * 1000;
    let utc_ms = ms - ms.rem_euclid(1000);
    local - utc_ms
}

#[cfg(not(any(windows, all(unix, target_pointer_width = "64"))))]
fn local_offset_ms(_ms: i64) -> i64 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers() {
        assert_eq!(int(18_442), "18,442");
        assert_eq!(int(999), "999");
        assert_eq!(int(1_000_000), "1,000,000");
        assert_eq!(bytes(612_884_201_472), "571 GB");
        assert_eq!(bytes(41_983_442_944), "39.1 GB");
        assert_eq!(bytes(0), "—");
        assert_eq!(bytes(512), "512 B");
        assert_eq!(interval(3600.0), "60 min");
        assert_eq!(interval(21_600.0), "6 hr");
        assert_eq!(interval(5400.0), "1.5 hr");
        assert_eq!(interval(0.0), "-");
        assert_eq!(pluralize(1, "user"), "1 user");
        assert_eq!(pluralize(5, "user"), "5 users");
    }

    #[test]
    fn iso_round_trips() {
        let ms = parse_iso("2026-10-11T08:12:00Z").unwrap();
        assert_eq!(to_iso(ms), "2026-10-11T08:12:00.000Z");
        assert_eq!(parse_iso("2026-10-11T10:12:00+02:00"), Some(ms));
        assert_eq!(parse_iso("2026-10-11T08:12:00.5Z"), Some(ms + 500));
        assert_eq!(parse_iso("nope"), None);
        assert_eq!(parse_iso("2026-02-30T00:00:00Z"), None);
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(civil_from_days(days_from_civil(2099, 11, 1)), (2099, 11, 1));
    }
}
