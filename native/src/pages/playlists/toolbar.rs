//! The playlist page's toolbar (`.playlist-toolbar`): the tabs, and on the
//! Tracks tab the list options (selection, sort) and the search.

use rune::{Color, Cursor, El, Key, KeyEvent, Tx, el, row, text};

use crate::app::App;
use crate::theme::{Theme, color_mix};
use crate::ui::forms::{SelectOption, SelectVariant, search_input_with, select};
use crate::ui::kit::toolbar_sep;
use crate::ui::{font, ico, icons as i, mono};

use super::detail::{Detail, Tab, detail_mut, set_sort, set_tab};
use super::logic::{self, SortKey};
use super::tracks;

/// The tab labels, with the collaborator count after "Collaborators".
fn tabs(t: &Theme, d: &Detail, collabs: bool, settings: bool) -> El {
    let mut options = vec![(Tab::Tracks, "Tracks", None)];
    if collabs {
        options.push((Tab::Collaborators, "Collaborators", (!d.collabs.is_empty()).then(|| d.collabs.len().to_string())));
    }
    if settings {
        options.push((Tab::Settings, "Settings", None));
    }
    segmented(t, "playlist-tabs", &options, d.tab)
}

/// `SegmentedControl` whose labels can carry a muted count.
// TODO(components-merge): fold into `ui::kit::segmented` once it takes rich labels.
fn segmented(t: &Theme, key: &str, options: &[(Tab, &str, Option<String>)], current: Tab) -> El {
    let mut group = row().key(key).h(32.0).padding(3.0).items_center().radius(t.radius_lg()).fill(t.c.muted).role("tablist");
    for (n, (value, label, count)) in options.iter().enumerate() {
        let active = *value == current;
        let v = *value;
        let mut b = row()
            .key(format!("{key}-{n}"))
            .h_full()
            .px(9.0)
            .gap(6.0)
            .radius(t.radius_md())
            .items_center()
            .role("tab")
            .label(label.to_string())
            .checked(active)
            .cursor(Cursor::Pointer)
            .on_press(move |app: &mut App| set_tab(app, v));
        if active {
            let mut pill = el()
                .key(format!("{key}-indicator"))
                .matched(format!("{key}-indicator"))
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .radius(t.radius_md())
                .motion(rune_motion::Spring::new(0.2, 0.0));
            if t.dark() {
                pill = pill.fill(t.c.input_bg).border(1.0, t.c.input);
            } else {
                pill = pill
                    .fill(t.c.background)
                    .box_shadow(rune::Shadow { x: 0.0, y: 1.0, blur: 3.0, spread: 0.0, color: Color::BLACK.alpha(0.1), inset: false })
                    .box_shadow(rune::Shadow { x: 0.0, y: 1.0, blur: 2.0, spread: -1.0, color: Color::BLACK.alpha(0.1), inset: false });
            }
            b = b.child(pill);
        }
        let ink = if active { t.c.foreground } else { t.c.muted_foreground };
        b = b.child(text(label.to_string()).font(font(14.0, 500.0)).color(ink).group_color(t.c.foreground));
        if let Some(c) = count {
            b = b.child(text(c.clone()).font(mono(14.0, 500.0)).color(t.c.muted_foreground).ml(4.0));
        }
        if !active {
            b = b.hover(Color::TRANSPARENT).press_scale(0.97);
        }
        group = group.child(b);
    }
    group
}

/// `.playlist-toolbar`: the tabs, and on Tracks the list options and search.
pub fn toolbar(app: &App, t: &Theme, d: &Detail, collabs: bool, settings: bool) -> El {
    let mut bar = row().key("playlist-toolbar").w_full().gap(12.0).items_center().child(tabs(t, d, collabs, settings));
    bar = bar.child(el().grow(1.0));
    if d.tab != Tab::Tracks {
        return bar;
    }
    let rows = d.tracks.as_deref().unwrap_or(&[]);
    if rows.len() > 1 {
        let options: Vec<SelectOption> = logic::SORT_OPTIONS.iter().map(|(k, l)| SelectOption::new(k.as_str(), *l)).collect();
        let mut group = row()
            .key("playlist-sort-controls")
            .min_h(32.0)
            .padding(3.0)
            .gap(2.0)
            .items_center()
            .radius(t.radius_lg())
            .fill(t.c.muted)
            .role("group")
            .label("Track list options")
            .child(tracks::selection_host(app, t, d))
            .child(toolbar_sep(t))
            .child(select(app, t, "playlist-sort", &options, d.sort.as_str(), SelectVariant::Toolbar, "", false, set_sort));
        if d.sort != SortKey::Custom {
            let hot = color_mix(t.c.foreground, 0.07, Color::TRANSPARENT);
            let label = if d.sort_asc {
                "Sorted ascending, switch to descending"
            } else {
                "Sorted descending, switch to ascending"
            };
            group = group.child(
                el().key("playlist-sort-dir")
                    .size(32.0, 26.0)
                    .radius(t.radius_md())
                    .center()
                    .role("button")
                    .label(label)
                    .cursor(Cursor::Pointer)
                    .focusable(true)
                    .hover(hot)
                    .press_scale(0.97)
                    .child(ico(if d.sort_asc { &i::ARROW_UP } else { &i::ARROW_DOWN }, 14.0, t.c.muted_foreground).group_color(t.c.foreground))
                    .on_press(|app: &mut App| {
                        if let Some(d) = detail_mut(app) {
                            d.sort_asc = !d.sort_asc;
                        }
                    }),
            );
        }
        bar = bar.child(group);
    }
    let search = search_input_with(t, "playlist-search", &app.pages.playlists.fields.search, "Search this playlist", Some(260.0), |f| {
        f.on_edit(|a: &mut App| &mut a.pages.playlists.fields.search).on_input_key(|a: &mut App, ev: &KeyEvent, tx: &mut Tx| {
            // Escape clears the query and leaves the field (`onClear`).
            if ev.key != Key::Escape {
                return false;
            }
            a.pages.playlists.fields.search.clear();
            tx.blur();
            true
        })
    });
    bar.child(search.shrink().min_w(180.0))
}
