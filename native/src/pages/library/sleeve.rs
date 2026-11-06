//! `AlbumSleeve.tsx` (`detail.css`): an album page as a sleeve. Who it is
//! in a 280 px column on the left (cover, title, artists, versions, Play,
//! one action row, Details), a rule, and the list on the right; the column
//! sticks while a long list scrolls. Under 720 px of content the column
//! stacks into a header above the list. While the album loads the same
//! frame shows placeholders.

use rune::{Cx, El, Link, LinkPaint, TextStyle, col, el, row, text};

use crate::api::TrackListItem;
use crate::app::App;
use crate::shell::{Bp, window_size};
use crate::theme::Theme;
use crate::ui::forms::search_input_with;
use crate::ui::kit::eyebrow;
use crate::ui::{self, Btn, BtnState, font, icons as i, iconbtn, tnum, with_lh};

use super::adapters::{self, Host};
use super::{exact, line_count};
use super::logic::{self, AlbumCredit, AlbumFact, FactKey};

/// Below this content width the column stacks above the list.
pub const STACK_BELOW_PX: f32 = 720.0;

/// What the sleeve shows of a loaded album.
pub struct SleeveAlbum<'a> {
    pub title: String,
    pub cover: Option<String>,
    pub credits: Vec<AlbumCredit>,
    pub facts: Vec<AlbumFact>,
    /// What "Saved" means on this kind of album page.
    pub saved_hint: &'static str,
    /// The whole list, for Play all.
    pub tracks: &'a [TrackListItem],
}

pub struct Sleeve<'a> {
    pub kind: &'static str,
    pub album: Option<SleeveAlbum<'a>>,
    pub loading_label: &'static str,
    pub versions: Option<El>,
    /// The action row under Play (one control, so it never wraps).
    pub actions: Vec<El>,
    /// While loading, hold the action row's place.
    pub reserve_actions: bool,
    pub loading_facts: &'static [&'static str],
    pub details_link: Option<El>,
    /// Admin: the pencil in the Details heading.
    pub on_edit: Option<fn(&mut App)>,
    /// (matches, total) for the search's count.
    pub matches: (usize, usize),
    /// The list: an error banner and the track table.
    pub list: Vec<El>,
}

/// The narrowest width `text` fits in `max` without taking more lines
/// (`text-wrap: balance`).
pub fn balanced_width(s: &str, style: TextStyle, max: f32) -> f32 {
    let measure = |w: f32| rune::text::measure_with(s, &[], style, Some(w), rune::text::RichLayoutOptions::new().wrap_anywhere());
    let (_, h) = measure(max);
    if h <= style.line_height * 1.5 {
        return max;
    }
    let (mut lo, mut hi) = (max / 2.0, max);
    for _ in 0..12 {
        let mid = (lo + hi) / 2.0;
        if measure(mid).1 > h + 0.5 { lo = mid } else { hi = mid }
    }
    hi.ceil().min(max)
}

/// A bar in place of a line of text (`.skeleton-text`).
pub fn skeleton(t: &Theme, w: f32, font_size: f32) -> El {
    el().w(w).h((font_size * 0.75).round()).radius(t.radius_sm()).fill(t.c.muted)
}

/// `.btn` with a 16 px icon.
pub fn button(key: &str, label: &str, glyph: Option<&'static rune::Icon>) -> Btn {
    let mut b = Btn::new(key, label).icon_size(16.0);
    if let Some(g) = glyph {
        b = b.icon(g);
    }
    b
}

/// The artists under the title; one with a library page links to it.
fn credits_line(t: &Theme, credits: &[AlbumCredit], max: f32) -> El {
    let mut s = String::new();
    let mut links = Vec::new();
    for (n, c) in credits.iter().enumerate() {
        if n > 0 {
            s.push_str(", ");
        }
        let start = s.len();
        s.push_str(&c.name);
        if let Some(id) = &c.artist_id {
            links.push(Link::new(start..s.len(), id.clone()).hover(LinkPaint::new().underline(t.c.foreground)));
        }
    }
    let mut e = text(s).font(font(14.0, 500.0)).color(t.c.foreground).wrap_anywhere().max_w(max);
    for l in links {
        e = e.link(l);
    }
    e.on_link(|app: &mut App, id: &str, _tx: &mut rune::Tx| super::artist_link(app, id))
}

/// `SleevePlay`: Play all, and the player's shuffle beside it.
fn play_row(app: &App, t: &Theme, tracks: &[TrackListItem], loading: bool, grow: bool) -> El {
    let can_play = tracks.iter().any(|t| t.unavailable != Some(true));
    let queue = tracks.to_vec();
    let mut play = button("sleeve-play", "Play all", Some(&i::PLAY_FILLED)).primary().disabled(!can_play).build(t);
    if grow {
        play = play.grow(1.0);
    }
    if can_play {
        play = play.on_press(move |app: &mut App| {
            logic::start_list_playback(&mut app.player, &queue);
        });
    }
    let on = app.player.shuffle;
    let mut shuffle = Btn::new("sleeve-shuffle", "").icon(&i::SHUFFLE).icon_size(16.0).disabled(loading).build(t).w(32.0).px(0.0);
    shuffle = shuffle.label("Shuffle").checked(on).help(if on { "Shuffle is on" } else { "Shuffle" });
    if on {
        shuffle = shuffle
            .fill(t.c.muted)
            .child(el().absolute(14.0, 25.0).size(4.0, 4.0).radius(99.0).fill(t.c.foreground).inert());
    }
    if !loading {
        shuffle = shuffle.on_press(|app: &mut App| app.player.toggle_shuffle());
    }
    row().w_full().gap(8.0).flex_wrap().child(play).child(shuffle)
}

fn fact_columns(width: f32) -> usize {
    (((width + 16.0) / 128.0).floor() as usize).max(1)
}

fn fact_column(width: f32) -> f32 {
    let n = fact_columns(width);
    (width - 16.0 * (n - 1) as f32) / n as f32
}

/// `.track-info-fields`: `repeat(auto-fill, minmax(112px, 1fr))`, gap 12 16.
fn facts_grid(t: &Theme, width: f32, facts: Vec<(String, El)>) -> El {
    let n = fact_columns(width);
    let w = fact_column(width);
    let mut out = col().w_full().gap(12.0);
    let mut it = facts.into_iter().peekable();
    while it.peek().is_some() {
        let mut r = row().gap(16.0).items_start();
        for (label, value) in it.by_ref().take(n) {
            let dt = font(12.0, 400.0);
            r = r.child(
                col().w(w).min_w(0.0).child(exact(text(label).font(dt).color(t.c.muted_foreground), dt, 1)).child(value.mt(2.0)),
            );
        }
        out = out.child(r);
    }
    out
}

fn details(t: &Theme, s: &mut Sleeve, width: f32) -> El {
    let fact_w = fact_column(width);
    let mut head = row().min_h(28.0).mb(6.0).gap(8.0).items_center().child(eyebrow(t, "Details").grow(1.0));
    if s.album.is_some()
        && let Some(link) = s.details_link.take()
    {
        head = head.child(link);
    }
    if let Some(edit) = s.on_edit {
        head = head.child(
            iconbtn(t, "sleeve-edit", &i::PENCIL, 14.0, BtnState::default())
                .size(28.0, 28.0)
                .label("Edit album")
                .help("Edit album")
                .on_press(edit),
        );
    }
    let facts: Vec<(String, El)> = match &s.album {
        Some(a) => a
            .facts
            .iter()
            .map(|f| {
                let dd = font(14.0, 400.0);
                let lines = line_count(&f.value, dd, fact_w);
                let mut v = text(f.value.clone()).font(dd).color(t.c.foreground).wrap_anywhere();
                if f.key == FactKey::Saved {
                    v = v.help(a.saved_hint);
                }
                (f.label.to_string(), exact(v, dd, lines))
            })
            .collect(),
        None => s
            .loading_facts
            .iter()
            .map(|l| (l.to_string(), el().h(20.3).items_center().child(skeleton(t, 70.0, 14.0))))
            .collect(),
    };
    let mut d = col().key("sleeve-details").w_full().min_w(0.0).pt(13.0).child(head).child(facts_grid(t, width, facts));
    d = d.child(el().pin(Some(0.0), Some(0.0), Some(0.0), None).h(1.0).fill(t.c.border).inert());
    d
}

/// The name block: kind, title (or two skeleton lines) and credits.
fn name_block(t: &Theme, s: &Sleeve, width: f32, title_style: TextStyle) -> El {
    let kind = font(12.0, 500.0);
    let mut name = col().w_full().min_w(0.0).gap(4.0).child(exact(text(s.kind).font(kind).color(t.c.muted_foreground), kind, 1));
    let title = match &s.album {
        Some(a) => {
            let shown = crate::format::display_text(Some(&a.title), "");
            let w = balanced_width(&shown, title_style, width);
            let lines = line_count(&shown, title_style, w);
            exact(text(shown).font(title_style).color(t.c.foreground).wrap_anywhere().w(w).role("heading"), title_style, lines)
        }
        None => {
            let lh = title_style.line_height;
            col()
                .child(el().h(lh).items_center().child(skeleton(t, (width * 0.9).floor(), title_style.size)))
                .child(el().h(lh).items_center().child(skeleton(t, (width * 0.55).floor(), title_style.size)))
        }
    };
    name = name.child(title.my(2.0));
    let by = font(14.0, 500.0);
    match &s.album {
        Some(a) if !a.credits.is_empty() => {
            let names: Vec<&str> = a.credits.iter().map(|c| c.name.as_str()).collect();
            let lines = line_count(&names.join(", "), by, width);
            name = name.child(exact(credits_line(t, &a.credits, width), by, lines));
        }
        Some(_) => {}
        None => {
            let st = font(14.0, 400.0);
            name = name.child(exact(text(s.loading_label).font(st).color(t.c.muted_foreground).role("status"), st, 1));
        }
    }
    name
}

/// The list's width: beside the column, or the content's when stacked.
pub fn list_width(t: &Theme, cx: &mut Cx<App>) -> f32 {
    let content_w = cx.layout_size("sleeve-view").map_or(956.0 + 2.0 * t.pad(), |r| r[0]) - 2.0 * t.pad();
    if content_w < STACK_BELOW_PX { content_w } else { content_w - 280.0 - 49.0 }
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>, mut s: Sleeve) -> El {
    let view_w = cx.layout_size("sleeve-view").map_or(956.0 + 2.0 * t.pad(), |r| r[0]);
    let content_w = view_w - 2.0 * t.pad();
    let stacked = content_w < STACK_BELOW_PX;
    let phone = stacked && Bp::of(window_size(cx)[0]) == Bp::Narrow;
    let tracks: &[TrackListItem] = s.album.as_ref().map_or(&[], |a| a.tracks);

    // The column.
    let (art_w, head_w) = if !stacked {
        (280.0, 280.0)
    } else if phone {
        (content_w.min(220.0), content_w)
    } else {
        (176.0, content_w - 176.0 - 24.0)
    };
    let title_style = if stacked && !phone {
        with_lh(font(30.0, 600.0), 33.0).tracking(-0.75)
    } else {
        with_lh(font(24.0, 600.0), 28.8).tracking(-0.48)
    };
    let art = match &s.album {
        Some(a) => ui::cover_art(t, &app.images, a.cover.as_deref(), &a.title, art_w, art_w, t.radius_lg()),
        None => el().size(art_w, art_w).radius(t.radius_lg()).fill(t.c.muted),
    };
    let grow_buttons = !stacked || phone;
    let mut head = col().w(head_w).min_w(0.0).gap(16.0).child(name_block(t, &s, head_w, title_style));
    if let Some(v) = s.versions.take() {
        head = head.child(if stacked && !phone { row().child(v) } else { v });
    }
    head = head.child(play_row(app, t, tracks, s.album.is_none(), grow_buttons));
    if s.album.is_some() {
        if !s.actions.is_empty() {
            let mut more = row().w_full().gap(8.0).flex_wrap();
            for a in std::mem::take(&mut s.actions) {
                more = more.child(if grow_buttons { a.grow(1.0) } else { a });
            }
            head = head.child(more);
        }
    } else if s.reserve_actions {
        let bar = el().h(32.0).radius(t.radius_lg()).fill(t.c.muted);
        head = head.child(row().w_full().child(if grow_buttons { bar.grow(1.0) } else { bar.w(160.0) }));
    }
    let details_w = if stacked { content_w } else { 280.0 };
    let side = if stacked && !phone {
        col()
            .key("sleeve-side")
            .w_full()
            .gap(16.0)
            .child(row().w_full().gap(24.0).items_end().child(art).child(head))
            .child(details(t, &mut s, details_w))
    } else {
        let mut c = col().key("sleeve-side").w(if phone { content_w } else { 280.0 }).gap(16.0);
        c = if phone { c.child(row().w_full().justify_center().child(art)) } else { c.child(art) };
        c.child(head).child(details(t, &mut s, details_w))
    };

    // The list.
    let search = &app.pages.library.detail.search;
    let search_w = if phone { None } else { Some(280.0f32.min(if stacked { content_w } else { content_w - 280.0 - 49.0 })) };
    let field = search_input_with(t, "sleeve-search", search, "Search this album", search_w, |f| {
        f.on_edit(|app: &mut App| &mut app.pages.library.detail.search).on_input_key(clear_on_escape)
    });
    let mut tools = row().w_full().gap(8.0).items_center().flex_wrap().child(if phone { field.grow(1.0).min_w(200.0) } else { field });
    if !search.text.trim().is_empty() {
        tools = tools.child(
            text(format!("{} of {} match", s.matches.0, s.matches.1)).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground),
        );
    }
    tools = tools.child(el().grow(1.0));
    let (controls, _) = adapters::selection_controls(app, t, Host::AlbumTools, s.album.is_some());
    for c in controls {
        tools = tools.child(c);
    }
    let mut list = col().key("sleeve-list").gap(8.0).min_w(0.0).child(tools);
    for c in std::mem::take(&mut s.list) {
        list = list.child(c);
    }

    let mut v = if stacked {
        col()
            .gap(20.0)
            .child(side)
            .child(el().w_full().h(1.0).fill(t.c.border))
            .child(list.w_full())
    } else {
        // `--sleeve-top`: under the view's padding, or higher for a column
        // taller than the content area, so its bottom shows first.
        let viewport = cx.layout_size("content").map_or(0.0, |r| r[1]);
        let column = cx.layout_size("sleeve-side").map_or(0.0, |r| r[1]);
        let room = if viewport > 0.0 { viewport - column - 2.0 * t.pad() } else { 0.0 };
        let top = t.pad() + room.min(0.0);
        row()
            .items_start()
            .gap(24.0)
            .child(side.sticky_top(top))
            .child(el().w(1.0).self_stretch().fill(t.c.border))
            .child(list.grow(1.0))
    };
    v = v.key("sleeve-view").w_full().padding(t.pad());
    if s.album.is_none() {
        v = v.role("status");
    }
    v
}

/// Escape clears the search and leaves the field (`SearchInput`'s `onClear`).
pub fn clear_on_escape(app: &mut App, ev: &rune::KeyEvent, tx: &mut rune::Tx) -> bool {
    if matches!(ev.key, rune::Key::Escape) {
        app.pages.library.detail.search.replace_text("");
        tx.blur();
        return true;
    }
    false
}
