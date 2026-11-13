//! The menu drawn (`TrackContextMenu.tsx`, `context-menu.css`): its header,
//! the action tiles, album and info rows, the playlists, and the footer.

use rune::{Color, Cursor, Cx, El, Shadow, col, el, row, text};
use rune_motion::{Spring, SpringPair, Transition, Vec2};

use super::{Item, Menu, THUMB, WIDTH, actions, close, plan, subline};
use crate::api::{self, Playlist, TrackListItem};
use crate::app::App;
use crate::core::track_menu::{FavoriteState, favorite_state, selection_artists, selection_covers};
use crate::format::display_text;
use crate::theme::Theme;
use crate::ui::{cover_art, cover_art_letter_size, font, ico, icons as i, line, mono, motion, track_row, with_lh};

/// The menu, at the pointer.
pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let m = app.overlays.track_menu.menu.as_ref()?;
    let p = plan(app, m);
    let win = crate::shell::window_size(cx);
    let size = cx.layout_size("track-menu").unwrap_or([WIDTH, 0.0]);
    // Flip away from the right and bottom edges, 8 px inside the window.
    let pad = 8.0;
    let [x, y] = m.at;
    let mut nx = if x + size[0] + pad > win[0] { win[0] - size[0] - pad } else { x };
    let mut ny = if y + size[1] + pad > win[1] { win[1] - size[1] - pad } else { y };
    nx = nx.max(pad);
    ny = ny.max(pad);
    // Scale out of the pointer.
    let origin = Vec2::new(((x - nx) / size[0].max(1.0)).clamp(0.0, 1.0), ((y - ny) / size[1].max(1.0)).clamp(0.0, 1.0));
    let enter = Spring::new(0.12, 0.0);
    let transition = Transition::scale_anchor(0.96, origin).springs(SpringPair::new(enter, Spring::NONE));

    let mut panel = crate::ui::kit::menu_panel(t, "track-menu", Some(WIDTH))
        .max_h(win[1] - 16.0)
        .absolute(nx, ny)
        .transition(transition)
        .label(match &m.many {
            Some(many) => format!("{} tracks", many.len()),
            None => display_text(Some(&m.track.title), ""),
        })
        .on_secondary_press(|_: &mut App, _, _| {});

    panel = panel.child(match &m.many {
        Some(many) => selection_header(app, t, many),
        None => track_header(app, t, &m.track),
    });

    // Everyday actions.
    let fav = match &m.many {
        Some(many) => favorite_state(many.iter().map(|t| t.id.as_str()), |id| app.pages.favorites_has(id)),
        None => favorite_state([m.track.id.as_str()], |id| app.pages.favorites_has(id)),
    };
    let mut tiles = row().w_full().gap(2.0);
    for (item, on) in &p.tiles {
        let meta = item.meta(m, fav);
        let tip = match item {
            Item::Play => (!p.can_play).then_some("No longer on TIDAL"),
            Item::Download => (!p.acts.download).then_some("No longer on TIDAL"),
            Item::Export => m.ctx.selection.as_ref().and_then(|s| s.export_disabled_reason.as_deref()),
            _ => None,
        };
        let key = format!("ctx-tile-{item:?}");
        let mut tile = item_base(t, &key, m.highlight.as_ref() == Some(item), *on)
            .grow(1.0)
            .min_w(0.0)
            .pt(8.0)
            .pb(6.0)
            .px(2.0)
            .gap(4.0)
            .items_center()
            .justify_center()
            .children(meta.glyph.map(|g| ico(g, 16.0, t.c.popover_foreground).group_color(t.c.accent_foreground)))
            .child(exact_line(line(meta.label, font(12.0, 400.0), t.c.popover_foreground).group_color(t.c.accent_foreground), 17.4));
        if item == &Item::Fav {
            tile = tile.role("menuitemcheckbox");
            tile = match fav {
                FavoriteState::All => tile.checked(true),
                FavoriteState::Some => tile.checked_mixed(),
                FavoriteState::None => tile.checked(false),
            };
        }
        tile = press(tile, item.clone(), *on);
        if let Some(tip) = tip {
            tile = crate::ui::tooltip::tip(tile, &key, tip);
        }
        tiles = tiles.child(tile);
    }
    panel = panel.child(tiles);

    // Album and info.
    if !p.rows.is_empty() {
        panel = panel.child(crate::ui::kit::menu_sep(t));
        for (item, on) in &p.rows {
            let meta = item.meta(m, fav);
            let lit = m.highlight.as_ref() == Some(item);
            panel = panel.child(press(list_item(t, &format!("ctx-{item:?}"), meta.glyph, meta.label, lit, *on), item.clone(), *on));
        }
    }

    // Playlists.
    panel = panel.child(crate::ui::kit::menu_sep(t)).child(heading(
        t,
        &match &m.many {
            Some(many) => format!("Add {} tracks to playlist", many.len()),
            None => "Add to playlist".into(),
        },
    ));
    if app.playlists.data.is_none() && m.playlists_error.is_none() {
        panel = panel.child(hint("Loading…", t.c.muted_foreground));
    }
    if let Some(err) = &m.playlists_error {
        let retry = Item::Retry.meta(m, fav);
        panel = panel.child(hint(err, t.c.muted_foreground)).child(press(
            list_item(t, "ctx-retry", retry.glyph, retry.label, m.highlight.as_ref() == Some(&Item::Retry), true),
            Item::Retry,
            true,
        ));
    }
    if app.playlists.data.is_some() && p.playlists.is_empty() {
        panel = panel.child(hint("No playlists you can edit.", t.c.muted_foreground));
    }
    if !p.playlists.is_empty() {
        let mut list = col().w_full();
        for (pl, enabled) in &p.playlists {
            list = list.child(playlist_item(app, t, m, pl, *enabled));
        }
        panel = panel.child(crate::ui::kit::scroll_area_with(t, "ctx-scroll", list, false).max_h(220.0).shrink());
    }
    if let Some(err) = &m.error {
        panel = panel.child(hint(err, t.c.destructive));
    }

    // The rare admin edits, kept quiet.
    if !p.foot.is_empty() {
        let mut foot = row().w_full().gap(2.0);
        for (item, on) in &p.foot {
            let meta = item.meta(m, fav);
            let ink = if meta.danger { t.c.destructive } else { t.c.muted_foreground };
            let hot = if meta.danger { t.c.destructive } else { t.c.accent_foreground };
            let b = item_row(t, &format!("ctx-{item:?}"), m.highlight.as_ref() == Some(item), *on)
                .grow(1.0)
                .min_w(0.0)
                .justify_center()
                .label(meta.aria.unwrap_or(meta.label))
                .children(meta.glyph.map(|g| ico(g, 14.0, ink).group_color(hot)))
                .child(exact_line(line(meta.label, font(13.0, 400.0), ink).group_color(hot), 18.85));
            foot = foot.child(press(b, item.clone(), *on));
        }
        panel = panel.child(crate::ui::kit::menu_sep(t)).child(foot);
    }

    Some(
        el().key("track-menu-layer")
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .modal(true, close)
            .child(el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).on_press(close).on_secondary_press(|app: &mut App, _, _| close(app)))
            .child(panel),
    )
}

/// `.ctx-item`'s box: hover and keyboard highlight in the accent, the
/// keyboard one ringed (`:focus-visible`).
fn item_base(t: &Theme, key: &str, highlighted: bool, enabled: bool) -> El {
    item_box(col(), t, key, highlighted, enabled)
}

/// [`item_base`] laid out in a row (the footer's icon and label).
fn item_row(t: &Theme, key: &str, highlighted: bool, enabled: bool) -> El {
    item_box(row(), t, key, highlighted, enabled).px(6.0).py(4.0).gap(6.0).items_center()
}

fn item_box(b: El, t: &Theme, key: &str, highlighted: bool, enabled: bool) -> El {
    let mut b = b.key(key).min_h(28.0).radius(t.radius_md()).role("menuitem").cursor(Cursor::Default);
    if !enabled {
        return b.opacity(0.5).disabled(true);
    }
    b = b.hover(t.c.accent).hover_motion(motion::ease(120.0), motion::ease(120.0)).press_scale(0.98);
    if highlighted {
        b = b.fill(t.c.accent).box_shadow(Shadow { x: 0.0, y: 0.0, blur: 0.0, spread: 2.0, color: t.c.focus_ring, inset: true });
    }
    b
}

/// A one-line `.ctx-item`: icon and label.
pub(crate) fn list_item(t: &Theme, key: &str, glyph: Option<&'static rune::Icon>, label: &str, highlighted: bool, enabled: bool) -> El {
    let mut r = row().key(key).w_full().min_h(28.0).px(6.0).py(4.0).gap(6.0).items_center();
    if let Some(g) = glyph {
        r = r.child(ico(g, 14.0, t.c.popover_foreground).group_color(t.c.accent_foreground));
    }
    r = r.child(exact_line(line(label, font(14.0, 400.0), t.c.popover_foreground).group_color(t.c.accent_foreground), 20.3));
    let base = item_base(t, &format!("{key}-item"), highlighted, enabled).w_full();
    base.child(r).label(label)
}

fn press(e: El, item: Item, enabled: bool) -> El {
    if !enabled {
        return e;
    }
    e.on_press(move |app: &mut App| actions::run(app, item.clone()))
}

/// A truncating line at the browser's fractional line height (Rune rounds
/// a text's box up, which adds up down the menu).
/// 14 px lines draw their glyphs a pixel row lower than Chromium unless
/// lifted by the rounding (measured against the reference; 12 and 13 px
/// lines land right as they are).
fn exact_line(e: El, lh: f32) -> El {
    crate::ui::exact(e, lh).shrink()
}

/// `.ctx-heading`.
fn heading(t: &Theme, s: &str) -> El {
    el().px(6.0).py(4.0).child(crate::ui::exact(text(s).font(font(12.0, 500.0)).color(t.c.muted_foreground), 17.4))
}

/// `.ctx-hint`.
fn hint(s: &str, ink: Color) -> El {
    el().w_full().px(6.0).py(4.0).child(text(s).font(font(12.0, 400.0)).color(ink).wrap())
}

/// `.ctx-pl`: a playlist's cover, name, and the owner of a shared one; the
/// row under the pointer shows a plus instead of the owner.
fn playlist_item(app: &App, t: &Theme, m: &Menu, pl: &Playlist, enabled: bool) -> El {
    let item = Item::Playlist(pl.id.clone());
    let added = m.added.contains(&pl.id);
    let busy = m.adding.as_deref() == Some(&pl.id);
    let lit = m.highlight.as_ref() == Some(&item);
    let art = api::media::playlist_art(pl, Some(THUMB));
    let owner = if pl.effective_role != Some(api::EffectiveRole::Owner) { pl.owner_name.clone() } else { None };
    let muted = t.c.muted_foreground;
    let mut r = row()
        .w_full()
        .min_h(28.0)
        .px(6.0)
        .py(4.0)
        .gap(6.0)
        .items_center()
        .child(cover_art_letter_size(t, &app.images, art.as_deref(), &pl.name, 18.0, t.radius_sm(), 12.0).ml(-2.0))
        .child(exact_line(line(pl.name.clone(), font(14.0, 400.0), t.c.popover_foreground).group_color(t.c.accent_foreground), 20.3).grow(1.0));
    if busy {
        r = r.child(text("…").font(mono(12.0, 400.0)).color(muted));
    } else if added {
        r = r.child(ico(&i::CHECK, 14.0, muted));
    } else {
        // `.ctx-pl-end`: the owner of a shared one; the row under the pointer
        // (or the highlight) swaps it for a plus. The plus doesn't take room
        // until then, so it draws over the name's end on the accent.
        let show = enabled && lit;
        if let Some(o) = owner {
            r = r.child(text(o).font(font(12.0, 400.0)).color(muted).group_opacity(if show { 0.0 } else { 1.0 }, if enabled { 0.0 } else { 1.0 }));
        }
        r = r.child(
            row()
                .pin(None, Some(0.0), Some(6.0), Some(0.0))
                .pl(6.0)
                .items_center()
                .fill(t.c.accent)
                .group_opacity(if show { 1.0 } else { 0.0 }, if enabled { 1.0 } else { 0.0 })
                .child(ico(&i::PLUS, 14.0, muted)),
        );
    }
    press(item_base(t, &format!("ctx-pl-{}", pl.id), lit, enabled).w_full().label(pl.name.clone()).child(r), item, enabled)
}

/// `TrackHeader`: the cover, title, and artist · album.
fn track_header(app: &App, t: &Theme, tr: &TrackListItem) -> El {
    let title = display_text(Some(&tr.title), "");
    let sub = subline(tr);
    let cover = tr.cover_at(Some(THUMB));
    row()
        .w_full()
        .gap(10.0)
        .pt(6.0)
        .px(6.0)
        .pb(8.0)
        .items_center()
        .child(cover_art(t, &app.images, Some(&cover), &track_row::art_label(tr), 40.0, 40.0, t.radius_md()))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .child(exact_line(
                    crate::ui::tooltip::tip_truncated(
                        line(title.clone(), with_lh(font(14.0, 500.0), 18.2), t.c.popover_foreground),
                        "ctx-head-title",
                        &title,
                        with_lh(font(14.0, 500.0), 18.2),
                    ),
                    18.2,
                ))
                .child(exact_line(
                    crate::ui::tooltip::tip_truncated(
                        line(sub.clone(), with_lh(font(12.0, 400.0), 16.8), t.c.muted_foreground),
                        "ctx-head-sub",
                        &sub,
                        with_lh(font(12.0, 400.0), 16.8),
                    ),
                    16.8,
                )),
        )
}

/// `SelectionHeader`: the covers fanned out, the count and the artists.
fn selection_header(app: &App, t: &Theme, tracks: &[TrackListItem]) -> El {
    let covers = selection_covers(tracks, 3);
    let mut stack = el().w(32.0 + 12.0 * (covers.len().saturating_sub(1)) as f32).h(40.0);
    for (n, tr) in covers.iter().enumerate() {
        let url = tr.cover_at(Some(THUMB));
        stack = stack.child(
            cover_art(t, &app.images, Some(&url), &track_row::art_label(tr), 32.0, 32.0, t.radius_md())
                .box_shadow(Shadow { x: 0.0, y: 0.0, blur: 0.0, spread: 2.0, color: t.c.popover, inset: false })
                .absolute(12.0 * n as f32, 4.0),
        );
    }
    let artists = selection_artists(tracks);
    let mut text_col = col()
        .grow(1.0)
        .min_w(0.0)
        .child(exact_line(line(format!("{} tracks", tracks.len()), with_lh(font(14.0, 500.0), 18.2), t.c.popover_foreground), 18.2));
    if !artists.is_empty() {
        text_col = text_col.child(exact_line(
            crate::ui::tooltip::tip_truncated(
                line(artists.clone(), with_lh(font(12.0, 400.0), 16.8), t.c.muted_foreground),
                "ctx-head-sub",
                &artists,
                with_lh(font(12.0, 400.0), 16.8),
            ),
            16.8,
        ));
    }
    row().w_full().gap(10.0).pt(6.0).px(6.0).pb(8.0).items_center().child(stack).child(text_col)
}
