//! `ReplayBentoPlaceholder` (`ReplayBento.tsx`, `replay.css`): the bento's
//! shape while a period loads. The same tiles and labels with bars in place
//! of the figures, so nothing moves when the data lands.

use rune::{El, col, el, row};

use super::bento::{
    CHART_H, FOOT_H, Fit, HEAD_H, LH12, LH14, PAD, ROW_H, Sub, Tile, chart_title, genre_row, head, label, panel, stat_label, stat_need,
    stat_tile, tile, value_lh,
};
use super::layout::{BentoTiles, Feat, arrange, minis};
use crate::api::stats::ReplayBucket;
use crate::theme::Theme;
use crate::ui::cards::media_card_placeholders;
use crate::ui::skeleton_line;

/// The placeholder bento. `unit_known` is false for all time, which may
/// count months instead of days: only its answer says, so until then the
/// days tile's label is a bar too.
pub(super) fn view(t: &Theme, chart_bucket: ReplayBucket, unit_known: bool, panel_w: f32) -> El {
    let fit = Fit::of(panel_w);
    let (areas, columns, width) = arrange(BentoTiles::ALL, false, fit, panel_w);
    let mut out: Vec<Tile> = Vec::new();

    // The most played track, one line of title.
    let f = Feat::of(fit);
    let Feat { pad, gap, art, title_size, title_lh } = f;
    let body = col()
        .grow(1.0)
        .min_w(0.0)
        .self_stretch()
        .justify_end()
        .child(label(t, "Most played track"))
        .child(skeleton_line(t, title_size, title_lh, 0.7).mt(6.0))
        .child(skeleton_line(t, 14.0, LH14, 0.55).mt(2.0))
        .child(skeleton_line(t, 14.0, LH14, 0.4).mt(12.0))
        .child(row().h(40.0).mt(16.0).items_center().child(el().size(40.0, 40.0).radius(999.0).fill(t.c.muted)));
    let mut feat = row()
        .key("replay-feat")
        .transition(rune::Transition::none())
        .min_w(0.0)
        .padding(pad)
        .gap(gap)
        .fill(t.c.card)
        .child(el().size(art, art).radius(t.radius_lg()).fill(t.c.muted))
        .child(body);
    feat = if fit.small { feat.items_start() } else { feat.items_center() };
    out.push(Tile { name: "feat", el: feat, need: f.need(1.0) });

    // The figures.
    for (name, text) in [("plays", Some("Plays")), ("time", Some("Listening time")), ("tracks", Some("Tracks")), ("days", unit_known.then_some("Days with plays"))] {
        let label = match text {
            Some(s) => stat_label(t, s),
            None => skeleton_line(t, 14.0, LH14, 0.6),
        };
        let size = if fit.small { 24.0 } else { 30.0 };
        out.push(Tile {
            name,
            el: stat_tile(
                t,
                &format!("replay-{name}"),
                label,
                skeleton_line(t, size, value_lh(fit), 0.45),
                Some(skeleton_line(t, 12.0, LH12, 0.65)),
                None,
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
                        .child(skeleton_line(t, 14.0, LH14, (60.0 - n as f32 * 4.0) / 100.0))
                        .child(skeleton_line(t, 12.0, LH12, 0.35)),
                ),
        );
    }
    // `.btn.btn-ghost.btn-sm` holding a 72 px bar of its 13 px type.
    let button = el().h(28.0).w(72.0 + 22.0).ml(-8.0).child(el().absolute(11.0, 14.0 - 0.75 * 13.0 / 2.0).size(72.0, 0.75 * 13.0).radius(t.radius_sm()).fill(t.c.muted));
    let list = tile(t, "replay-list").child(head(t, label(t, "Also on repeat"), None)).child(rows).child(row().w_full().mt(8.0).child(button));
    out.push(Tile { name: "list", el: list, need: 2.0 * PAD + HEAD_H + 7.0 * ROW_H + FOOT_H });

    // The chart's frame: its baseline under the room the bars take.
    let chart = el().w_full().h(CHART_H).pt(8.0).pb(28.0).child(crate::ui::css_border_bottom(el().w_full().h_full(), 1.0, t.c.border));
    out.push(Tile {
        name: "act",
        el: tile(t, "replay-act").child(head(t, label(t, chart_title(chart_bucket)), None)).child(chart),
        need: 2.0 * PAD + HEAD_H + CHART_H,
    });

    let mut genres = col().w_full().gap(8.0);
    for n in 0..5 {
        genres = genres.child(genre_row(t, &format!("replay-genre-{n}"), skeleton_line(t, 14.0, LH14, 0.7), None, None));
    }
    out.push(Tile {
        name: "genre",
        el: tile(t, "replay-genre").child(head(t, label(t, "Genres"), None)).child(genres),
        need: 2.0 * PAD + HEAD_H + 5.0 * LH14 + 4.0 * 8.0,
    });

    for (name, text) in [("art", "Top artists"), ("alb", "Top albums")] {
        // Both cover tiles are there, so neither spans the panel alone.
        let (minis, card_w) = minis(t, width(name), false, fit);
        let mut shelf = row().gap(t.gap());
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
    panel(t, "replay-bento-loading", &areas, columns, panel_w, out).role("status").label("Loading Replay")
}
