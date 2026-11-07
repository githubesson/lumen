//! `PlaylistSettingsPanel.tsx`: cover, details and deletion for the owner,
//! TIDAL auto-download for admins (`detail.css` `.playlist-settings`). The
//! text details save together; the cover and the switch apply at once.

use rune::{El, col, row};

use crate::api::{Playlist, Visibility};
use crate::app::App;
use crate::theme::Theme;
use crate::ui::forms::{Desc, SelectOption, setting_row, setting_select};
use crate::ui::kit::{error_banner, switch};
use crate::ui::{Btn, icons as i, input_with};

use super::collaborators::surface;
use super::detail::{self, Detail, detail_mut};
use super::logic::{Details, Permissions, details_form, details_payload, is_valid_name, pluralize, same_details};
use super::Fields;

/// The details form: edited or not, and its save.
#[derive(Default)]
pub struct State {
    /// The visibility shown (the name and description are in `Fields`).
    pub visibility: Visibility,
    /// Edited since the last save: the fields stop following the playlist.
    pub edited: bool,
    pub busy: bool,
    pub error: Option<String>,
}

impl State {
    pub fn new(p: Option<&Playlist>) -> State {
        State { visibility: p.map(|p| p.visibility).unwrap_or_default(), ..State::default() }
    }
}

/// The form's values (`draft ?? saved`).
fn values(s: &State, f: &Fields) -> Details {
    Details { name: f.name.text.clone(), description: f.description.text.clone(), visibility: s.visibility }
}

/// Unedited, the form shows the saved details, so a reload shows through.
pub fn sync(d: &mut Detail, f: &mut Fields) {
    if !d.settings.edited
        && let Some(p) = &d.loaded
    {
        let saved = details_form(p);
        set_fields(&mut d.settings, f, saved);
    }
}

/// [`sync`] for a new visit, from what it was seeded with.
pub fn sync_fields(d: &Detail, f: &mut Fields) {
    if let Some(p) = &d.loaded {
        let saved = details_form(p);
        f.name.replace_text(saved.name);
        f.description.replace_text(saved.description);
    }
}

fn set_fields(s: &mut State, f: &mut Fields, v: Details) {
    if f.name.text != v.name {
        f.name.replace_text(v.name);
    }
    if f.description.text != v.description {
        f.description.replace_text(v.description);
    }
    s.visibility = v.visibility;
}

fn saved(app: &App) -> Option<Details> {
    let d = detail::detail(app)?;
    detail::playlist(app, d).map(details_form)
}

fn edited(app: &mut App) {
    if let Some(d) = detail_mut(app) {
        d.settings.edited = true;
    }
}

fn discard(app: &mut App) {
    let Some(v) = saved(app) else { return };
    let fields = &mut app.pages.playlists.fields;
    if let Some(d) = app.pages.playlists.detail.as_mut() {
        d.settings.edited = false;
        d.settings.error = None;
        set_fields(&mut d.settings, fields, v);
    }
}

fn save(app: &mut App) {
    let Some(d) = detail::detail(app) else { return };
    let v = values(&d.settings, &app.pages.playlists.fields);
    if !is_valid_name(&v.name) {
        detail_mut(app).unwrap().settings.error = Some("Give the playlist a name.".into());
        return;
    }
    let submitted = details_payload(&v.name, &v.description, v.visibility);
    let s = &mut detail_mut(app).unwrap().settings;
    s.busy = true;
    s.error = None;
    let sent = submitted.clone();
    detail::save_details(app, submitted, move |app, result| {
        let fields = &mut app.pages.playlists.fields;
        let Some(d) = app.pages.playlists.detail.as_mut() else { return };
        d.settings.busy = false;
        match result {
            // Typing can carry on while the save is out; keep anything newer.
            Ok(()) => {
                let now = values(&d.settings, fields);
                if same_details(&now, &sent) {
                    d.settings.edited = false;
                    if let Some(p) = &d.loaded {
                        let v = details_form(p);
                        set_fields(&mut d.settings, fields, v);
                    }
                }
            }
            Err(message) => d.settings.error = Some(message),
        }
    });
}

fn set_visibility(app: &mut App, value: &str) {
    if let Some(d) = detail_mut(app) {
        d.settings.visibility = if value == "collaborative" { Visibility::Collaborative } else { Visibility::Private };
        d.settings.edited = true;
    }
}

/// The visibility's `<Select variant="minimal">`.
fn visibility_select(app: &App, t: &Theme, value: Visibility) -> El {
    let options = vec![SelectOption::new("private", "Private"), SelectOption::new("collaborative", "Collaborative")];
    let value = if value == Visibility::Collaborative { "collaborative" } else { "private" };
    setting_select(app, t, "playlist-visibility", options, value, false, set_visibility).label("Visibility")
}

/// `.surface.playlist-settings-card`.
fn card(t: &Theme, rows: El) -> El {
    surface(t, col().w_full().px(16.0).child(rows))
}

pub fn view(app: &App, t: &Theme, d: &Detail, p: &Playlist, perms: &Permissions, auto: bool, queued: u32) -> El {
    let s = &d.settings;
    let f = &app.pages.playlists.fields;
    let mut panel = col().key("playlist-settings").w_full().max_w(720.0);
    let mut first = true;
    let mut add = |panel: El, title: &str, body: El| {
        let sec = crate::ui::blocks::section(t, &format!("playlist-section-{title}"), None, title, None, body);
        let sec = if first { sec } else { sec.mt(28.0) };
        first = false;
        panel.child(sec)
    };
    if perms.can_edit_details {
        let v = values(s, f);
        let dirty = s.edited && saved(app).is_some_and(|saved| !same_details(&v, &saved));
        let custom = p.custom_cover.as_deref().is_some_and(|c| !c.is_empty());
        let mut buttons = row().gap(8.0);
        if custom {
            let remove = Btn::new("playlist-cover-remove", "Remove").small().ghost().disabled(d.saving_cover).build(t);
            buttons = buttons.child(if d.saving_cover { remove } else { remove.on_press(detail::remove_cover) });
        }
        let choose = Btn::new("playlist-cover-choose", if d.saving_cover { "Uploading…" } else { "Choose image" })
            .small()
            .icon(&i::IMAGE_UP)
            .disabled(d.saving_cover)
            .build(t);
        buttons = buttons.child(if d.saving_cover { choose } else { choose.on_press_tx(detail::pick_cover) });
        let name = input_with(t, "playlist-name", &f.name, "", |e| {
            e.label("Name")
                .on_edit(|a: &mut App| &mut a.pages.playlists.fields.name)
                .on_input_change(|a: &mut App, _| edited(a))
                .on_submit(|a: &mut App, _| save(a))
        });
        let description = input_with(t, "playlist-description", &f.description, "Optional", |e| {
            e.label("Description")
                .on_edit(|a: &mut App| &mut a.pages.playlists.fields.description)
                .on_input_change(|a: &mut App, _| edited(a))
                .on_submit(|a: &mut App, _| save(a))
        });
        let mut form = col()
            .w_full()
            .child(setting_row(
                t,
                "Cover",
                Some(Desc::Text(if custom { "Your image. JPEG, PNG or WebP." } else { "The first track's art, until you choose an image." }.into())),
                Some(buttons),
                None,
                None,
                false,
            ))
            .child(setting_row(t, "Name", None, None, Some(name), None, false))
            .child(setting_row(t, "Description", None, None, Some(description), None, false))
            .child(setting_row(
                t,
                "Visibility",
                Some(Desc::Text(
                    if v.visibility == Visibility::Collaborative {
                        "People you invite can see it, and editors can add tracks."
                    } else {
                        "Only you can see it."
                    }
                    .into(),
                )),
                Some(visibility_select(app, t, v.visibility)),
                None,
                None,
                false,
            ));
        if let Some(e) = &s.error {
            form = form.child(error_banner(t, e).mt(12.0));
        }
        let mut actions = row().w_full().justify_end().gap(8.0).pt(12.0).pb(16.0);
        if dirty {
            let discard_btn = Btn::new("playlist-details-discard", "Discard").ghost().disabled(s.busy).build(t);
            actions = actions.child(if s.busy { discard_btn } else { discard_btn.on_press(discard) });
        }
        let save_btn = Btn::new("playlist-details-save", "Save").primary().disabled(!dirty || s.busy).build(t);
        actions = actions.child(if !dirty || s.busy { save_btn } else { save_btn.on_press(save) });
        panel = add(panel, "Details", card(t, form.child(actions)));
    }
    if perms.can_toggle_tidal_auto_download {
        let mut desc = "Downloads this playlist's TIDAL tracks to the server, now and as they're added.".to_string();
        if auto && queued > 0 {
            desc.push_str(&format!(" {} still queued.", pluralize(queued as usize, "track")));
        }
        let toggle = switch(t, "playlist-tidal", auto, d.saving_auto, detail::toggle_auto_download);
        let body = setting_row(t, "Save TIDAL tracks to the library", Some(Desc::Text(desc)), Some(toggle), None, None, true);
        panel = add(panel, "Downloads", card(t, body));
    }
    if perms.can_delete {
        let desc = if p.visibility == Visibility::Collaborative {
            "Removes it for you and everyone you've invited. This can't be undone."
        } else {
            "This can't be undone."
        };
        let delete = Btn::new("playlist-delete", "Delete").danger().small().icon(&i::TRASH_2).build(t).on_press(detail::delete);
        panel = add(panel, "Danger zone", card(t, setting_row(t, "Delete playlist", Some(Desc::Text(desc.into())), Some(delete), None, None, true)));
    }
    panel
}
