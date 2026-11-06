//! `ActivityChart.tsx` (`replay.css`): Replay's listening activity, one bar
//! per bucket over a baseline, with up to six date ticks under it and each
//! bar's date and play count in its tooltip.

use rune::{El, col, el, row, text};

use crate::theme::Theme;
use crate::ui::{font, tooltip};

/// `ReplayBucket`: what one bar counts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Bucket {
    #[default]
    Day,
    Week,
    Month,
}

/// One bar: `bucket_start` (an ISO date at UTC midnight) and its plays.
#[derive(Clone, Debug, PartialEq)]
pub struct Bar {
    pub start: String,
    pub plays: u64,
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG: [&str; 12] =
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The UTC day of an ISO timestamp ("2026-09-04T00:00:00Z"), in days since the epoch.
pub fn utc_day(iso: &str) -> Option<i64> {
    let date = iso.get(0..10)?;
    let mut it = date.split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: u32 = it.next()?.parse().ok()?;
    let d: u32 = it.next()?.parse().ok()?;
    Some(days_from_civil(y, m, d))
}

fn md(day: i64) -> String {
    let (_, m, d) = civil_from_days(day);
    format!("{} {d}", MONTHS[(m - 1) as usize])
}

fn mdy(day: i64) -> String {
    let (y, m, d) = civil_from_days(day);
    format!("{} {d}, {y}", MONTHS[(m - 1) as usize])
}

/// `activityBucketLabel(date, bucket, "verbose")`: "Sep 4", or "Sep 26" for a month.
pub fn bucket_label(day: i64, bucket: Bucket) -> String {
    match bucket {
        Bucket::Day | Bucket::Week => md(day),
        Bucket::Month => {
            let (y, m, _) = civil_from_days(day);
            format!("{} {:02}", MONTHS[(m - 1) as usize], y.rem_euclid(100))
        }
    }
}

/// The bar's tooltip date: "Thu, Sep 4, 2026", "Week of Sep 4 – Sep 10, 2026",
/// "September 2026".
pub fn bucket_tooltip(day: i64, bucket: Bucket) -> String {
    match bucket {
        Bucket::Day => format!("{}, {}", WEEKDAYS[day.rem_euclid(7) as usize], mdy(day)),
        Bucket::Week => format!("Week of {} – {}", md(day), mdy(day + 6)),
        Bucket::Month => {
            let (y, m, _) = civil_from_days(day);
            format!("{} {y}", MONTHS_LONG[(m - 1) as usize])
        }
    }
}

/// `activityChartScale`: the tallest bar and how many bars per tick (six
/// ticks at most).
pub fn chart_scale(bars: &[Bar]) -> (u64, usize) {
    let max = bars.iter().map(|b| b.plays).max().unwrap_or(0);
    (max, bars.len().div_ceil(6).max(1))
}

/// `ActivityChart`, or its empty card.
pub fn activity_chart(t: &Theme, key: &str, bars: &[Bar], bucket: Bucket) -> El {
    if bars.is_empty() {
        return crate::ui::css_border(el(), 1.0, t.c.border, t.radius_xl())
            .key(key)
            .w_full()
            .padding(29.0)
            .radius(t.radius_xl())
            .fill(t.c.card)
            .center()
            .child(text("No listening activity in this window.").font(font(14.0, 400.0)).color(t.c.muted_foreground));
    }
    let (max, step) = chart_scale(bars);
    // `.activity-chart`: 140 px, padded 8 0 28; the bars sit on a hairline.
    let plot_h = 140.0 - 8.0 - 28.0 - 1.0;
    let mut cols = row().key(format!("{key}-bars")).w_full().h(plot_h).gap(3.0).items_end().justify_center().role("img").label("Listening activity");
    for (n, b) in bars.iter().enumerate() {
        let day = utc_day(&b.start).unwrap_or(0);
        let pct = if max > 0 { b.plays as f32 / max as f32 } else { 0.0 };
        let plays = if b.plays == 1 { "1 play".to_string() } else { format!("{} plays", b.plays) };
        let tip = format!("{} · {plays}", bucket_tooltip(day, bucket));
        let ck = format!("{key}-col-{n}");
        let bar = el()
            .w_full()
            .h((plot_h * pct).max(2.0))
            .corners([4.0, 4.0, 0.0, 0.0])
            .fill(t.c.primary)
            .group_opacity(0.85, 1.0);
        let mut c = col().key(ck.clone()).grow(1.0).min_w(4.0).max_w(56.0).h_full().justify_end().hover_group().child(bar);
        if n % step == 0 {
            // `.activity-tick`: centred 22 px under the baseline's bottom.
            let label = text(bucket_label(day, bucket)).font(font(12.0, 400.0)).color(t.c.muted_foreground);
            c = c.child(el().pin(Some(-40.0), None, Some(-40.0), Some(-22.0)).h(17.4).center().child(label));
        }
        cols = cols.child(tooltip::tip(c, &ck, &tip));
    }
    let plot = crate::ui::css_border_bottom(el().w_full().pb(1.0).child(cols), 1.0, t.c.border);
    col().key(key).w_full().h(140.0).pt(8.0).pb(28.0).child(plot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        let d = utc_day("2026-09-04T00:00:00Z").unwrap();
        assert_eq!(bucket_label(d, Bucket::Day), "Sep 4");
        assert_eq!(bucket_tooltip(d, Bucket::Day), "Fri, Sep 4, 2026");
        assert_eq!(bucket_tooltip(d, Bucket::Week), "Week of Sep 4 – Sep 10, 2026");
        assert_eq!(bucket_tooltip(d, Bucket::Month), "September 2026");
        assert_eq!(bucket_label(d, Bucket::Month), "Sep 26");
        assert_eq!(chart_scale(&vec![Bar { start: String::new(), plays: 3 }; 13]), (3, 3));
    }
}
