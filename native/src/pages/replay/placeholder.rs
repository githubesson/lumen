//! `ReplayBentoPlaceholder` (`ReplayBento.tsx`, `replay.css`): the bento's
//! shape while a period loads. The same tiles and labels with bars in place
//! of the figures, so nothing moves when the data lands.

use rune::{El, col, el, row};

use super::bento::{
    FOOT_H, Fit, HEAD_H, LH12, LH14, PAD, ROW_H, Sub, Tile, chart_title, genre_row, head, label, panel, stat_label, stat_need,
    stat_tile, tile, value_lh,
};
use super::layout::{BentoTiles, bento_areas, cells, column, span_width};
use crate::api::stats::ReplayBucket;
use crate::app::App;
use crate::theme::Theme;
use crate::ui::cards::media_card_placeholders;

/// `.skeleton-text`: an inline block 0.75 em tall at `vertical-align:
/// middle` (its middle on the baseline raised by half the x-height) in a
/// line of `size` px type `lh` tall, `frac` of the line's width.
fn bar(t: &Theme, size: f32, lh: f32, width: Width) -> El {
    // Geist: the baseline sits lh/2 + 0.355 em down; the x-height is 0.53 em.
    let top = lh / 2.0 + 0.355 * size - 0.265 * size - 0.375 * size;
    let b = el().absolute(0.0, top).h(0.75 * size).radius(t.radius_sm()).fill(t.c.muted);
    let b = match width {
        Width::Frac(f) => b.w_frac(f),
        Width::Px(px) => b.w(px),
    };
    el().w_full().h(lh).child(b)
}

#[derive(Clone, Copy)]
enum Width {
    Frac(f32),
    Px(f32),
}

/// The placeholder bento. `unit_known` is false for all time, which may
/// count months instead of days: only its answer says, so until then the
/// days tile's label is a bar too.
pub(super) fn view(app: &App, t: &Theme, chart_bucket: ReplayBucket, unit_known: bool, panel_w: f32) -> El {
    let fit = Fit::of(panel_w);
    let (wide, narrow) = bento_areas(BentoTiles::ALL, false);
    let (areas, columns) = if fit.wide { (wide, 4) } else { (narrow, 2) };
    let col_w = column(panel_w - 2.0, columns);
    let all = cells(&areas);
    let width = |name: &str| all.iter().find(|c| c.name == name).map_or(0.0, |c| span_width(col_w, c.c1 - c.c0));
    let mut out: Vec<Tile> = Vec::new();

    // The most played track.
    let (pad, gap, art) = if fit.small { (16.0, 16.0, 112.0) } else { (20.0, 20.0, 208.0) };
    let (title_size, title_lh) = if fit.small { (20.0, 24.0) } else { (24.0, 28.8) };
    let body = col()
        .grow(1.0)
        .min_w(0.0)
        .self_stretch()
        .justify_end()
        .child(label(t, "Most played track"))
        .child(bar(t, title_size, title_lh, Width::Frac(0.7)).mt(6.0))
        .child(bar(t, 14.0, LH14, Width::Frac(0.55)).mt(2.0))
        .child(bar(t, 14.0, LH14, Width::Frac(0.4)).mt(12.0))
        .child(row().h(40.0).mt(16.0).items_center().child(el().size(40.0, 40.0).radius(999.0).fill(t.c.muted)));
    let mut feat = row()
        .key("replay-feat")
        .min_w(0.0)
        .padding(pad)
        .gap(gap)
        .fill(t.c.card)
        .child(el().size(art, art).radius(t.radius_lg()).fill(t.c.muted))
        .child(body);
    feat = if fit.small { feat.items_start() } else { feat.items_center() };
    let body_h = LH14 + 6.0 + title_lh + 2.0 + LH14 + 12.0 + LH14 + 16.0 + 40.0;
    out.push(Tile { name: "feat", el: feat, need: 2.0 * pad + art.max(body_h) });

    // The figures.
    for (name, text) in [("plays", Some("Plays")), ("time", Some("Listening time")), ("tracks", Some("Tracks")), ("days", unit_known.then_some("Days with plays"))] {
        let label = match text {
            Some(s) => stat_label(t, s),
            None => bar(t, 14.0, LH14, Width::Frac(0.6)),
        };
        let size = if fit.small { 24.0 } else { 30.0 };
        out.push(Tile {
            name,
            el: stat_tile(
                t,
                &format!("replay-{name}"),
                label,
                bar(t, size, value_lh(fit), Width::Frac(0.45)),
                Some(bar(t, 12.0, LH12, Width::Frac(0.65))),
            ),
            need: stat_need(fit, Sub::Text),
        });
    }

    // Also on repeat: most periods have more top tracks than the panel lists.
    let row_w = width("list") - 2.0 * PAD + 16.0;
    // The grid's text column: what the rank, cover, bar and count columns
    // and the gaps between them leave.
    let text_w = if fit.small { row_w - 16.0 - 24.0 - 32.0 - 32.0 - 3.0 * 12.0 } else { row_w - 16.0 - 24.0 - 32.0 - 72.0 - 32.0 - 4.0 * 12.0 };
    let mut rows = col().w_full();
    for n in 0..7 {
        rows = rows.child(
            row()
                .w(row_w)
                .ml(-8.0)
                .h(ROW_H)
                .px(8.0)
                .gap(12.0)
                .items_center()
                .child(el().w(24.0))
                .child(el().size(32.0, 32.0).radius(t.radius_md()).fill(t.c.muted))
                .child(
                    col()
                        .w(text_w)
                        .child(bar(t, 14.0, LH14, Width::Frac((60.0 - n as f32 * 4.0) / 100.0)))
                        .child(bar(t, 12.0, LH12, Width::Frac(0.35))),
                ),
        );
    }
    // `.btn.btn-ghost.btn-sm` holding a 72 px bar of its 13 px type.
    let button = el().h(28.0).w(72.0 + 22.0).ml(-8.0).child(el().absolute(11.0, 14.0 - 0.75 * 13.0 / 2.0).size(72.0, 0.75 * 13.0).radius(t.radius_sm()).fill(t.c.muted));
    let list = tile(t, "replay-list").child(head(t, label(t, "Also on repeat"), None)).child(rows).child(row().w_full().mt(8.0).child(button));
    out.push(Tile { name: "list", el: list, need: 2.0 * PAD + HEAD_H + 7.0 * ROW_H + FOOT_H });

    // The chart's frame: its baseline under the room the bars take.
    let chart = el().w_full().h(124.0).pt(8.0).pb(28.0).child(crate::ui::css_border_bottom(el().w_full().h_full(), 1.0, t.c.border));
    out.push(Tile {
        name: "act",
        el: tile(t, "replay-act").child(head(t, label(t, chart_title(chart_bucket)), None)).child(chart),
        need: 2.0 * PAD + HEAD_H + 124.0,
    });

    let mut genres = col().w_full().gap(8.0);
    for n in 0..5 {
        genres = genres.child(genre_row(t, &format!("replay-genre-{n}"), bar(t, 14.0, LH14, Width::Frac(0.7)), None, None));
    }
    out.push(Tile {
        name: "genre",
        el: tile(t, "replay-genre").child(head(t, label(t, "Genres"), None)).child(genres),
        need: 2.0 * PAD + HEAD_H + 5.0 * LH14 + 4.0 * 8.0,
    });

    for (name, text) in [("art", "Top artists"), ("alb", "Top albums")] {
        let minis = width(name) - 2.0 * PAD + 16.0;
        let g = t.gap();
        let card_w = if fit.small { (minis - 2.0 * g) / 2.3 } else { (minis - 3.0 * g) / 4.0 };
        let mut shelf = row().gap(g);
        for c in media_card_placeholders(t, &format!("replay-{name}-ph"), 4) {
            shelf = shelf.child(el().w(card_w).min_w(card_w).child(c));
        }
        out.push(Tile {
            name,
            el: tile(t, &format!("replay-{name}"))
                .child(head(t, label(t, text), None))
                .child(el().w(minis).ml(-8.0).mb(-8.0).clip_rounded(0.0).child(shelf)),
            need: 0.0,
        });
    }
    let _ = app;
    panel(t, "replay-bento-loading", &areas, columns, panel_w, out).role("status").label("Loading Replay")
}
