//! `ActivityChart.tsx` (`replay.css`): Replay's listening activity, one bar
//! per bucket over a baseline, with up to six date ticks under it and each
//! bar's date and play count in its tooltip.

use rune::{El, col, el, row, text};

use crate::api::stats::{ReplayActivityBucket, ReplayBucket};
use crate::core::dates::{self, MONTHS_LONG, MONTHS_SHORT, WEEKDAYS_SHORT};
use crate::core::replay::figures::{activity_bucket_label, activity_chart_scale};
use crate::theme::Theme;
use crate::ui::{font, tooltip};

/// A bucket's start (`new Date(b.bucket_start)`): the instant, read in UTC
/// for its labels as the web reads it.
fn bucket_ms(b: &ReplayActivityBucket) -> i64 {
    dates::parse(&b.bucket_start).unwrap_or(0)
}

/// "Sep 4"
fn month_day(p: &dates::Parts) -> String {
    format!("{} {}", MONTHS_SHORT[p.month as usize - 1], p.day)
}

/// The bar's tooltip date (`tooltipFor`, in UTC): "Fri, Sep 4, 2026",
/// "Week of Sep 4 – Sep 10, 2026", "September 2026".
pub fn bucket_tooltip(start_ms: i64, bucket: ReplayBucket) -> String {
    let p = dates::utc_parts(start_ms);
    match bucket {
        ReplayBucket::Day => format!("{}, {}, {}", WEEKDAYS_SHORT[p.weekday as usize], month_day(&p), p.year),
        ReplayBucket::Week => {
            let end = dates::utc_parts(start_ms + 6 * dates::DAY_MS);
            format!("Week of {} – {}, {}", month_day(&p), month_day(&end), end.year)
        }
        ReplayBucket::Month => format!("{} {}", MONTHS_LONG[p.month as usize - 1], p.year),
    }
}

/// `ActivityChart` (or its empty card) `h` px tall instead of
/// `.activity-chart`'s 140: Home's `.board-chart` stretches it over the
/// panel's room, Replay's bento sets 124.
pub fn activity_chart_sized(t: &Theme, key: &str, buckets: &[ReplayActivityBucket], bucket: ReplayBucket, h: f32) -> El {
    if buckets.is_empty() {
        return crate::ui::css_border(el(), 1.0, t.c.border, t.radius_xl())
            .key(key)
            .w_full()
            .padding(29.0)
            .radius(t.radius_xl())
            .fill(t.c.card)
            .center()
            .child(text("No listening activity in this window.").font(font(14.0, 400.0)).color(t.c.muted_foreground));
    }
    let (max, step) = activity_chart_scale(buckets, 6);
    // `.activity-chart`: 140 px, padded 8 0 28; the bars sit on a hairline.
    let plot_h = (h - 8.0 - 28.0 - 1.0).max(0.0);
    let mut cols = row().key(format!("{key}-bars")).w_full().h(plot_h).gap(3.0).items_end().justify_center().role("img").label("Listening activity");
    for (n, b) in buckets.iter().enumerate() {
        let start = bucket_ms(b);
        let pct = if max > 0 { b.plays as f32 / max as f32 } else { 0.0 };
        let plays = if b.plays == 1 { "1 play".to_string() } else { format!("{} plays", b.plays) };
        let tip = format!("{} · {plays}", bucket_tooltip(start, bucket));
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
            let label = text(activity_bucket_label(start, bucket)).font(font(12.0, 400.0)).color(t.c.muted_foreground);
            c = c.child(el().pin(Some(-40.0), None, Some(-40.0), Some(-22.0)).h(17.4).center().child(label));
        }
        cols = cols.child(tooltip::tip(c, &ck, &tip));
    }
    let plot = crate::ui::css_border_bottom(el().w_full().pb(1.0).child(cols), 1.0, t.c.border);
    col().key(key).w_full().h(h).pt(8.0).pb(28.0).child(plot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltips() {
        let d = dates::parse("2026-09-04T00:00:00Z").unwrap();
        assert_eq!(bucket_tooltip(d, ReplayBucket::Day), "Fri, Sep 4, 2026");
        assert_eq!(bucket_tooltip(d, ReplayBucket::Week), "Week of Sep 4 – Sep 10, 2026");
        assert_eq!(bucket_tooltip(d, ReplayBucket::Month), "September 2026");
        // `new Date(..)` keeps the instant: a bucket at another zone's
        // midnight reads as the UTC day it falls in.
        let east = dates::parse("2026-09-04T00:00:00+02:00").unwrap();
        assert_eq!(bucket_tooltip(east, ReplayBucket::Day), "Thu, Sep 3, 2026");
        assert_eq!(bucket_tooltip(dates::parse("2026-12-28T00:00:00Z").unwrap(), ReplayBucket::Week), "Week of Dec 28 – Jan 3, 2027");
    }
}
