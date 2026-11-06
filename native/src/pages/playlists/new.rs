//! `PlaylistNew.tsx` (with `RadioCardOption.tsx`), at `/playlists/new`.

use rune::{Color, Cursor, El, TextEdit, col, el, row, text};

use crate::api::Visibility;
use crate::app::App;
use crate::theme::{Theme, color_mix};
use crate::ui::forms::field;
use crate::ui::kit::{error_banner, eyebrow};
use crate::ui::{Btn, css_border, font, input_with};

use super::logic::{ch60, details_payload, error_message, is_valid_name};
use super::requests;

pub struct State {
    pub name: TextEdit,
    pub description: TextEdit,
    pub visibility: Visibility,
    pub error: Option<String>,
    pub busy: bool,
}

impl Default for State {
    fn default() -> Self {
        State {
            name: TextEdit::new(""),
            description: TextEdit::new(""),
            visibility: Visibility::Private,
            error: None,
            busy: false,
        }
    }
}

/// A fresh form, the name field focused (`autoFocus`).
pub fn enter(app: &mut App) {
    let mut s = State::default();
    s.name.focused = true;
    app.pages.playlists.new = s;
}

/// A whitespace-only name passes `required` but the server refuses it.
fn can_submit(s: &State) -> bool {
    is_valid_name(&s.name.text) && !s.busy
}

fn submit(app: &mut App) {
    let s = &mut app.pages.playlists.new;
    if !can_submit(s) {
        return;
    }
    let Some(client) = app.client.clone() else { return };
    s.error = None;
    s.busy = true;
    let d = details_payload(&s.name.text, &s.description.text, s.visibility);
    app.net.run(
        move || requests::create_playlist(&client, &d.name, Some(&d.description), Some(d.visibility)),
        |app, result| {
            app.pages.playlists.new.busy = false;
            match result {
                Ok(p) => {
                    app.load_playlists();
                    if app.location().is("/playlists/new") {
                        app.navigate_replace(crate::route::Location::parse(&format!("/playlists/{}", p.id)));
                    }
                }
                Err(e) => app.pages.playlists.new.error = Some(error_message(&e, "Failed to create playlist.")),
            }
        },
    );
}

/// `RadioCardOption`: a bordered card with a radio, its label and a line
/// under it; the checked one is outlined in the primary colour.
pub fn radio_card(t: &Theme, key: &str, checked: bool, label: &str, description: &str, on_pick: impl Fn(&mut App) + 'static) -> El {
    let r = t.radius_lg();
    let mut card = css_border(row(), 1.0, if checked { t.c.primary } else { t.c.border }, r)
        .key(key)
        .w_full()
        .padding(13.0)
        .gap(12.0)
        .items_start()
        .radius(r)
        .role("radio")
        .checked(checked)
        .label(label.to_string())
        .cursor(Cursor::Pointer)
        .focusable(true)
        .on_press(on_pick);
    if checked {
        card = card.fill(color_mix(t.c.primary, 0.05, Color::TRANSPARENT));
    }
    card.child(radio(t, checked).mt(2.0)).child(
        col()
            .grow(1.0)
            .min_w(0.0)
            .child(text(label).font(font(14.0, 500.0)).color(t.c.foreground).h(20.3))
            .child(text(description).font(font(12.0, 400.0)).color(t.c.muted_foreground).h(17.4).mt(2.0)),
    )
}

/// A native `<input type="radio">` with `accent-color: var(--primary)`, as
/// Chromium draws it: a 13 px ring on the field colour; checked, the ring and
/// a dot in the accent with a field-coloured gap between them.
pub fn radio(t: &Theme, checked: bool) -> El {
    let ring = if t.dark() { rune::color::hex("#858585").unwrap() } else { rune::color::hex("#767676").unwrap() };
    let field = if t.dark() { rune::color::hex("#3b3b3b").unwrap() } else { Color::WHITE };
    if checked {
        el().size(13.0, 13.0).radius(6.5).fill(t.c.primary).center().child(
            el().size(11.0, 11.0).radius(5.5).fill(field).center().child(el().size(8.6, 8.6).radius(4.3).fill(t.c.primary)),
        )
    } else {
        css_border(el().size(13.0, 13.0).radius(6.5).fill(field), 1.0, ring, 6.5)
    }
}

pub fn view(app: &App, t: &Theme, _cx: &mut rune::Cx<App>) -> El {
    let s = &app.pages.playlists.new;
    let name = input_with(t, "new-playlist-name", &s.name, "", |f| {
        f.label("Name").on_edit(|a: &mut App| &mut a.pages.playlists.new.name).on_submit(|a: &mut App, _| submit(a))
    });
    let description = input_with(t, "new-playlist-description", &s.description, "", |f| {
        f.label("Description")
            .on_edit(|a: &mut App| &mut a.pages.playlists.new.description)
            .on_submit(|a: &mut App, _| submit(a))
    });
    let vis = s.visibility;
    let visibility = col()
        .w_full()
        .child(eyebrow(t, "Visibility").h(17.4).mb(4.0))
        .child(
            col()
                .w_full()
                .gap(8.0)
                .role("radiogroup")
                .child(radio_card(t, "new-playlist-private", vis == Visibility::Private, "Private", "Only you can see or edit this playlist.", |a: &mut App| {
                    a.pages.playlists.new.visibility = Visibility::Private
                }))
                .child(radio_card(
                    t,
                    "new-playlist-collaborative",
                    vis == Visibility::Collaborative,
                    "Collaborative",
                    "Invited users can view or edit, per-role.",
                    |a: &mut App| a.pages.playlists.new.visibility = Visibility::Collaborative,
                )),
        );
    let create = Btn::new("new-playlist-create", if s.busy { "Creating…" } else { "Create playlist" })
        .primary()
        .disabled(!can_submit(s))
        .build(t)
        .on_press(submit);
    let cancel = Btn::new("new-playlist-cancel", "Cancel").ghost().build(t).on_press(|a: &mut App| a.back());
    let mut form = col()
        .key("new-playlist-form")
        .w_full()
        .max_w(480.0)
        .gap(16.0)
        .child(field(t, "Name", name, None, None))
        // `Field`'s hint, one line box tall.
        .child(field(t, "Description", description, None, None).child(text("Optional").font(font(12.0, 400.0)).color(t.c.muted_foreground).h(17.4)))
        .child(visibility);
    if let Some(e) = &s.error {
        form = form.child(error_banner(t, e));
    }
    form = form.child(row().gap(8.0).child(create).child(cancel));
    col()
        .key("new-playlist-view")
        .w_full()
        .padding(t.pad())
        .child(super::list::page_header(t, "New playlist", None, None))
        .child(
            el().w_full().max_w(ch60(14.0)).mb(28.0).child(
                text("Playlists are private by default. Collaborative ones let you invite other users as viewers or editors.")
                    .font(font(14.0, 400.0))
                    .color(t.c.muted_foreground)
                    .wrap()
                    .w_full(),
            ),
        )
        .child(form)
}

