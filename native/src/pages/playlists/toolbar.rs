//! The playlist page's toolbar (`.playlist-toolbar`): the tabs, and on the
//! Tracks tab the list options (selection, sort) and the search.

use rune::{Color, Cursor, El, Key, KeyEvent, Tx, el, row};

use crate::app::App;
use crate::theme::{Theme, color_mix};
use crate::ui::forms::{SelectOption, SelectVariant, search_input_with, select};
use crate::ui::kit::{SegSize, segmented_counted, toolbar_sep};
use crate::ui::{ico, icons as i};

use super::detail::{Detail, Tab, detail_mut, set_sort, set_tab};
use super::logic::{self, SortKey};
use super::tracks;

/// The tab labels, with the collaborator count after "Collaborators".
fn tabs(t: &Theme, d: &Detail, collabs: bool, settings: bool) -> El {
    let count = (!d.collabs.is_empty()).then(|| d.collabs.len().to_string());
    let mut options = vec![(Tab::Tracks, "Tracks", None)];
    if collabs {
        options.push((Tab::Collaborators, "Collaborators", count.as_deref()));
    }
    if settings {
        options.push((Tab::Settings, "Settings", None));
    }
    segmented_counted(t, "playlist-tabs", &options, d.tab, set_tab, SegSize::DEFAULT)
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
            .child(tracks::selection_host(app, t));
        // While selecting, the group holds only the selection's controls.
        let selecting = tracks::is_selecting(app);
        if !selecting {
            group = group
                .child(toolbar_sep(t))
                .child(select(app, t, "playlist-sort", &options, d.sort.as_str(), SelectVariant::Toolbar, "", false, set_sort));
        }
        if d.sort != SortKey::Custom && !selecting {
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
