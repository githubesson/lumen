//! `TrackList.tsx` (`library.css`): the track table every list page shares
//! (Library, Favorites, Recent, search results, album and artist pages,
//! Replay), with its selection bar, header, rows and right-click menu.
//!
//! A list reads its rows from the app's state through a [`Source`], so its
//! rows can be built lazily:
//!
//! ```ignore
//! // Short lists: the bar and the table, in the page's own column.
//! TrackList::new("artist-popular", |a| &a.pages.library.popular).headless().build(app, t)
//! // Long lists: the whole page as the content's virtual rows, `head` on top.
//! TrackList::new("favorites", |a| &a.pages.favorites.tracks).page(app, t, head, None)
//! ```

use std::borrow::Cow;
use std::rc::Rc;

use rune::{Cursor, El, GrowthSpec, col, el, row, text};

use crate::api::TrackListItem;
use crate::app::App;
use crate::theme::Theme;
use crate::ui::track_row::{self, RowSpec};
use crate::ui::track_select::{self, BarPlace, Source};
use crate::ui::{css_border_bottom, font};

/// `extraColumn`: a column between Album and Time (Replay's plays).
#[derive(Clone)]
pub struct Extra {
    pub header: &'static str,
    /// The column's width (its class's `width`).
    pub width: f32,
    /// `text-align: right`.
    pub align_end: bool,
    pub render: fn(&App, &Theme, &TrackListItem) -> El,
}

/// `<TrackList>`'s props. Build with [`TrackList::new`] and the setters.
#[derive(Clone)]
pub struct TrackList {
    key: String,
    source: Source,
    queue: Option<Source>,
    cover: bool,
    album: bool,
    header: bool,
    selectable: bool,
    source_badge: bool,
    bar: Option<BarPlace>,
    omit_artists: Vec<String>,
    extra: Option<Extra>,
    empty: Option<El>,
    /// The gap of the grid the list sits in (a `.view`'s 18 px), which
    /// also falls between its bar and its table.
    gap: f32,
}

impl TrackList {
    /// A list keyed `key` (its selection and element keys) showing `source`.
    pub fn new(key: impl Into<String>, source: Source) -> TrackList {
        TrackList {
            key: key.into(),
            source,
            queue: None,
            cover: true,
            album: true,
            header: true,
            selectable: true,
            source_badge: true,
            bar: Some(BarPlace::Inline),
            omit_artists: Vec::new(),
            extra: None,
            empty: None,
            gap: 0.0,
        }
    }
    /// The list's parts are items of a grid with this gap (`.view`'s
    /// `display: grid; gap: 18px`): it goes under the page's head and
    /// between the bar and the table.
    pub fn view_gap(mut self, gap: f32) -> Self {
        self.gap = gap;
        self
    }
    /// `queueSource`: what plays when a row does (defaults to the rows).
    pub fn queue(mut self, queue: Source) -> Self {
        self.queue = Some(queue);
        self
    }
    /// `showCover={false}`.
    pub fn no_cover(mut self) -> Self {
        self.cover = false;
        self
    }
    /// `showAlbum={false}`.
    pub fn no_album(mut self) -> Self {
        self.album = false;
        self
    }
    /// `showHeader={false}`: the header row's labels go, its line stays out.
    pub fn headless(mut self) -> Self {
        self.header = false;
        self
    }
    /// `selectable={false}`: no selection bar or shortcuts.
    pub fn not_selectable(mut self) -> Self {
        self.selectable = false;
        self.bar = None;
        self
    }
    /// `showSourceBadge={false}`.
    pub fn no_source_badge(mut self) -> Self {
        self.source_badge = false;
        self
    }
    /// `selectionControlsHostId`: the page draws [`track_select::selection_bar`]
    /// itself (in its toolbar group), so the list leaves it out.
    pub fn bar_elsewhere(mut self) -> Self {
        self.bar = None;
        self
    }
    /// `omitArtists`: rows crediting only these leave out the artist line.
    pub fn omit_artists(mut self, names: Vec<String>) -> Self {
        self.omit_artists = names;
        self
    }
    /// `extraColumn`.
    pub fn extra(mut self, extra: Extra) -> Self {
        self.extra = Some(extra);
        self
    }
    /// `emptyState`: shown instead of the table when there are no rows.
    pub fn empty(mut self, empty: El) -> Self {
        self.empty = Some(empty);
        self
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    /// The selection bar this list draws (for a page that hosts it).
    pub fn selection_bar(&self, app: &App, t: &Theme, place: BarPlace) -> El {
        track_select::selection_bar(app, t, &self.key, self.source, place)
    }

    /// The list in a column: the selection bar, the header and every row.
    /// For short lists; [`TrackList::page`] virtualizes long ones.
    pub fn build(self, app: &App, t: &Theme) -> El {
        let items = (self.source)(app);
        if items.is_empty() {
            return self.empty.clone().unwrap_or_else(el);
        }
        if self.selectable {
            app.widgets.lists.mount(&self.key, self.source);
        }
        let mut c = col().key(format!("{}-list", self.key)).w_full().gap(self.gap);
        if let Some(place) = self.bar {
            c = c.child(self.selection_bar(app, t, place));
        }
        c = c.child(self.header_row(app, t));
        for (n, tr) in items.iter().enumerate() {
            c = c.child(self.row(app, t, n, tr));
        }
        c
    }

    /// The whole page as virtual rows of the content scroller: `head` (the
    /// page's header, padded like `.view`), then the selection bar and the
    /// table's header, one row per track, and `tail`. Return it as the
    /// page's view; only the rows near the viewport are built.
    pub fn page(self, app: &App, t: &Theme, head: El, tail: Option<El>) -> El {
        let pad = t.pad();
        let items = (self.source)(app);
        if self.selectable && !items.is_empty() {
            app.widgets.lists.mount(&self.key, self.source);
        }
        let count = items.len();
        // Rows: head, then (with tracks) the bar and the header, the tracks,
        // then the tail (or the empty state).
        let lead = if count == 0 { 1 } else { 1 + usize::from(self.bar.is_some()) + 1 };
        let total = lead + count + 1;
        let me = Rc::new(self);
        let (head, tail) = (Rc::new(head), Rc::new(tail));
        let keys = me.clone();
        let build = me.clone();
        col()
            .key(format!("{}-page", me.key))
            .w_full()
            .growth(GrowthSpec { edge: rune::edge::NO_MASK, ..GrowthSpec::default() })
            .virtual_rows(
                total,
                t.row_h(),
                move |app: &App, i| -> Cow<'_, str> {
                    let items = (keys.source)(app);
                    let lead = if items.is_empty() { 1 } else { 1 + usize::from(keys.bar.is_some()) + 1 };
                    if i == 0 {
                        Cow::Borrowed("page-head")
                    } else if i < lead {
                        Cow::Borrowed(if i + 1 == lead { "page-thead" } else { "page-bar" })
                    } else if i - lead < items.len() {
                        Cow::Owned(format!("t:{}", items[i - lead].id))
                    } else {
                        Cow::Borrowed("page-tail")
                    }
                },
                move |app: &App, i| {
                    let t = app.theme();
                    let pad = t.pad();
                    let items = (build.source)(app);
                    let lead = if items.is_empty() { 1 } else { 1 + usize::from(build.bar.is_some()) + 1 };
                    let wrap = |e: El| el().w_full().px(pad).child(e);
                    if i == 0 {
                        let g = if items.is_empty() && build.empty.is_none() { 0.0 } else { build.gap };
                        return wrap((*head).clone()).pt(pad).pb(g);
                    }
                    if i < lead {
                        return if i + 1 == lead {
                            wrap(build.header_row(app, &t))
                        } else {
                            wrap(build.selection_bar(app, &t, BarPlace::Inline)).pb(build.gap)
                        };
                    }
                    if i - lead < items.len() {
                        let n = i - lead;
                        return wrap(build.row(app, &t, n, &items[n]));
                    }
                    let mut end = el().w_full().px(pad).pb(pad);
                    if items.is_empty() {
                        end = end.child(build.empty.clone().unwrap_or_else(el));
                    }
                    if let Some(tail) = &*tail {
                        end = end.child(tail.clone());
                    }
                    end
                },
            )
            .virtual_rows_version((count, pad.to_bits(), lead, items.first().map(|t| t.id.clone()), items.last().map(|t| t.id.clone())))
    }

    fn row(&self, app: &App, t: &Theme, index: usize, tr: &TrackListItem) -> El {
        let artist = self.omit_artists.is_empty() || !track_row::credits_only(tr.artist.as_deref(), &self.omit_artists);
        track_row::track_row(
            app,
            t,
            RowSpec {
                list: &self.key,
                source: self.source,
                queue: self.queue.unwrap_or(self.source),
                index,
                track: tr,
                cover: self.cover,
                album: self.album,
                source_badge: self.source_badge,
                artist,
                extra: self.extra.as_ref(),
            },
        )
    }

    /// `<thead>`: 40 px of 12 px labels over a hairline, with the
    /// select-all checkbox while selecting.
    fn header_row(&self, app: &App, t: &Theme) -> El {
        let items = (self.source)(app);
        let sel = app.widgets.lists.get(&self.key);
        let label = |s: &str| -> El {
            if self.header { text(s).font(font(12.0, 500.0)).color(t.c.muted_foreground) } else { el() }
        };
        let label_end = |s: &str| -> El {
            if self.header { crate::ui::text_end(s, font(12.0, 500.0), t.c.muted_foreground) } else { el() }
        };
        let h = if self.header { 40.0 } else { 0.0 };
        let mut r = row().key(format!("{}-thead", self.key)).w_full().h(h).items_center();
        if self.header {
            // `.table thead th { background: var(--background) }`: seen
            // where the table sits on a card (Replay's top tracks).
            r = css_border_bottom(r.pb(1.0).fill(t.c.background), 1.0, t.c.border);
        }
        let (all, some) = (sel.all_selected(items), sel.some_selected(items));
        let key = self.key.clone();
        let source = self.source;
        let check = track_select::checkbox(t, &format!("{}-checkall", self.key), all, some && !all, if all {
            "Deselect all tracks"
        } else {
            "Select all tracks"
        })
        .opacity(if sel.mode { 1.0 } else { 0.0 })
        .opacity_motion(crate::ui::motion::ease_out(150.0))
        .offset(if sel.mode { 0.0 } else { -4.0 }, 0.0)
        .offset_motion(crate::ui::motion::ease_out(150.0))
        .on_press(move |app: &mut App| track_select::select_all(app, &key, source));
        let check = if sel.mode { check } else { check.inert() };
        r = r.child(el().w(if sel.mode { 32.0 } else { 0.0 }).h_full().center().clip_rounded(0.0).child(check));
        r = r.child(row().w(40.0).px(8.0).justify_end().child(label_end("#")));
        if self.cover {
            r = r.child(el().w(44.0));
        }
        r = r.child(row().grow(1.0).min_w(0.0).px(8.0).child(label("Title")));
        if self.album {
            r = r.child(row().w_frac(0.25).px(8.0).child(label("Album")));
        }
        if let Some(x) = &self.extra {
            let mut c = row().w(x.width).px(8.0);
            if x.align_end {
                c = c.justify_end();
            }
            r = r.child(c.child(if x.align_end { label_end(x.header) } else { label(x.header) }));
        }
        r = r.child(row().w(64.0).px(8.0).justify_end().child(label_end("Time")));
        r.child(el().w(80.0)).cursor(Cursor::Default)
    }
}

/// A row's right-click: the track menu at the pointer, for the selection
/// when the row is part of one of two or more (`useMenuSelection`).
pub fn open_menu(app: &mut App, list: &str, source: Source, queue: Source, tr: &TrackListItem, at: [f32; 2]) {
    use crate::overlays::track_menu::{self, MenuContext, MenuSelection};
    let sel = app.widgets.lists.get(list);
    let items = source(app);
    let selection = if sel.mode && sel.count(items) > 1 && sel.ids.contains(&tr.id) {
        let tracks: Vec<TrackListItem> = sel.selected(items).into_iter().cloned().collect();
        let local = tracks.iter().any(track_row::is_local);
        Some(MenuSelection {
            tracks,
            list: Some((list.to_string(), source)),
            export_disabled_reason: (!local).then(|| track_select::EXPORT_DISABLED_REASON.to_string()),
        })
    } else {
        None
    };
    let is_admin = app.me().is_some_and(|m| m.is_admin());
    let acts = track_row::actions(tr, is_admin);
    let ctx = MenuContext {
        queue: track_row::playable(queue(app)),
        edit: acts.edit_metadata,
        move_to_album: acts.move_to_album,
        info: true,
        share: track_row::can_share(tr),
        selection,
    };
    track_menu::open(app, tr.clone(), at, ctx);
}
