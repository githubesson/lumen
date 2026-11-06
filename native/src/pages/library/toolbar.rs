//! `BrowseToolbar.tsx`: the view tabs (or the search's type tabs), the
//! tracks' option bar (selection controls, sort, list/grid) and the search
//! box, whose typing applies after a pause (`LibrarySearchInput`).

use std::time::Duration;

use rune::{Color, Cursor, Cx, El, Shadow, el, row, text};

use crate::app::App;
use crate::theme::Theme;
use crate::ui::forms::{SelectOption, SelectVariant, search_input_with, select};
use crate::ui::kit::{segmented, toolbar_group, toolbar_sep};
use crate::ui::{font, ico, icons as i};

use super::adapters::{self, Host};
use super::requests::{SEARCH_DEBOUNCE_MS, SEARCH_TYPE_OPTIONS, SearchType};
use super::{Display, Sort, View};

const SORT_OPTIONS: [(Sort, &str); 5] = [
    (Sort::Recent, "Recently added"),
    (Sort::Title, "Title"),
    (Sort::Artist, "Artist"),
    (Sort::Album, "Album"),
    (Sort::Duration, "Duration"),
];

fn search_noun(t: SearchType) -> &'static str {
    match t {
        SearchType::All => "all music",
        SearchType::Track => "tracks",
        SearchType::Album => "albums",
        SearchType::Artist => "artists",
    }
}

pub fn sort_options() -> Vec<SelectOption> {
    SORT_OPTIONS.iter().map(|(s, l)| SelectOption::new(s.param(), *l)).collect()
}

/// The search box's width and whether it wraps onto its own line, as CSS
/// flex-wrap lays out `[tabs] [flex: 1] [group] [search: 1 1 180px, max
/// 260px]` with 12 px gaps in `width`.
fn search_width(width: f32, tabs: f32, group: Option<f32>) -> f32 {
    const GAP: f32 = 12.0;
    let line1 = tabs + GAP + group.map_or(0.0, |g| g + GAP);
    if line1 + GAP + 180.0 <= width {
        // One line: the spacer (basis 0) and the search (basis 180) split the free space.
        let free = width - line1 - GAP - 180.0;
        return (180.0 + free / 2.0).min(260.0);
    }
    // The group wraps with the search when even it doesn't fit beside the tabs.
    match group {
        Some(g) if tabs + GAP + g > width => (width - g - GAP).clamp(180.0, 260.0).min(width),
        _ => width.min(260.0),
    }
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>, view: View, query: &str, search_type: SearchType) -> El {
    let s = &app.pages.library;
    let searching = !query.trim().is_empty();
    let tabs = if searching {
        segmented(t, "lib-tabs", &SEARCH_TYPE_OPTIONS, search_type, |app, ty| super::set_search_type(app, ty))
    } else {
        segmented(
            t,
            "lib-tabs",
            &[(View::Tracks, "Tracks"), (View::Albums, "Albums"), (View::Artists, "Artists")],
            view,
            |app, v| super::set_view(app, v),
        )
    };
    let mut bar = row().key("lib-toolbar").w_full().mt(18.0).gap(12.0).items_center().flex_wrap().child(tabs);
    bar = bar.child(el().grow(1.0).h(1.0));
    let has_group = !searching && view == View::Tracks;
    if has_group {
        let list = s.display == Display::List;
        let mut parts: Vec<El> = Vec::new();
        let mut selecting = false;
        if list {
            let ready = s.tracks.items.as_ref().is_some_and(|i| !i.is_empty());
            let (controls, on) = adapters::selection_controls(app, t, Host::LibraryToolbar, ready);
            selecting = on;
            parts.extend(controls);
            if !on {
                parts.push(toolbar_sep(t));
            }
        }
        if !selecting {
            parts.push(select(
                app,
                t,
                "lib-sort",
                &sort_options(),
                s.sort.param(),
                SelectVariant::Toolbar,
                "",
                false,
                |app, v| super::set_sort(app, Sort::parse(v)),
            ));
            parts.push(toolbar_sep(t));
            parts.push(display_toggle(t, s.display));
        }
        bar = bar.child(toolbar_group(t, "lib-tools", parts).role("group").label("Track list options"));
    }
    let width = cx.layout_size("lib-toolbar").map_or(956.0, |s| s[0]);
    let tabs_w = cx.layout_size("lib-tabs").map_or(196.0, |s| s[0]);
    let group_w = if has_group { Some(cx.layout_size("lib-tools").map_or(304.0, |s| s[0])) } else { None };
    let w = search_width(width, tabs_w, group_w);
    let placeholder = format!("Search {}, local + TIDAL", search_noun(search_type));
    let field = search_input_with(t, "lib-search", &s.query_edit, &placeholder, Some(w), |f| {
        f.label("Search music")
            .on_edit(|app: &mut App| {
                super::query_edited(app);
                &mut app.pages.library.query_edit
            })
            .on_submit(|app: &mut App, _tx| super::apply_draft(app))
    });
    bar.child(field)
}

/// A pause in typing applies the draft: each edit arms a timer, and the
/// newest one to fire (if the draft still differs) sets the query.
pub fn arm_debounce(app: &mut App) {
    let s = &mut app.pages.library;
    s.query_gen += 1;
    let seq = s.query_gen;
    let tx = app.net.sender();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(SEARCH_DEBOUNCE_MS));
        tx.send(move |app| {
            if app.pages.library.query_gen == seq {
                super::apply_draft(app);
            }
        });
    });
}

/// The list/grid toggle inside the group: a `.segmented` without its own
/// track, 26 px tall, icon-only buttons.
fn display_toggle(t: &Theme, current: Display) -> El {
    let mut g = row().key("lib-display").h(26.0).items_center().role("tablist").label("Display mode");
    for (n, (value, glyph, label)) in [(Display::List, &i::LIST, "List"), (Display::Grid, &i::LAYOUT_GRID, "Grid")].into_iter().enumerate() {
        let active = value == current;
        let mut b = el()
            .key(format!("lib-display-{n}"))
            .h_full()
            .px(7.0)
            .radius(t.radius_md())
            .items_center()
            .role("tab")
            .label(label)
            .checked(active)
            .cursor(Cursor::Pointer)
            .on_press(move |app: &mut App| super::set_display(app, value));
        if active {
            let mut pill = el()
                .key("lib-display-indicator")
                .matched("lib-display-indicator")
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .radius(t.radius_md())
                .motion(rune_motion::Spring::new(0.2, 0.0));
            if t.dark() {
                pill = pill.fill(t.c.input_bg).border(1.0, t.c.input);
            } else {
                pill = pill
                    .fill(t.c.background)
                    .box_shadow(Shadow { x: 0.0, y: 1.0, blur: 3.0, spread: 0.0, color: Color::BLACK.alpha(0.1), inset: false })
                    .box_shadow(Shadow { x: 0.0, y: 1.0, blur: 2.0, spread: -1.0, color: Color::BLACK.alpha(0.1), inset: false });
            }
            b = b.child(pill);
        }
        let ink = if active { t.c.foreground } else { t.c.muted_foreground };
        b = b.child(ico(glyph, 14.0, ink).group_color(t.c.foreground));
        if !active {
            b = b.hover(Color::TRANSPARENT).press_scale(0.97);
        }
        g = g.child(b);
    }
    g
}

/// `LibraryEmptyState`: its hint's "upload them" opens the upload dialog.
pub fn empty_library(t: &Theme) -> El {
    let lead = "Drop audio files into a watched folder on the server, or ";
    let link = "upload them";
    let hint = format!("{lead}{link}. New files are ingested automatically.");
    let range = lead.len()..lead.len() + link.len();
    let hint = text(hint)
        .font(font(14.0, 400.0))
        .color(t.c.muted_foreground)
        .wrap()
        .align(rune::Align::Center)
        .spans(vec![rune::Span::new(range.start, range.end).color(t.c.primary)])
        .link(rune::Link::new(range, "upload").role("button"))
        .on_link(|app: &mut App, _id: &str, _tx: &mut rune::Tx| app.ui.upload_open = true);
    rune::col()
        .w_full()
        .px(24.0)
        .py(48.0)
        .gap(8.0)
        .items_center()
        .child(text("Your library is empty.").font(font(16.0, 500.0)).color(t.c.foreground))
        .child(hint)
}
