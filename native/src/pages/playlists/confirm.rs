//! The confirmations the playlist pages ask (delete, leave, remove,
//! withdraw), drawn as `ConfirmDialog.tsx` draws them (`confirm.css`).
//
// TODO(components-merge): the overlays agent's `crate::overlays::confirm`
// has this API (`ConfirmSpec`, `Art`, `ask`); call `overlays::confirm::ask`
// and delete this module.

use rune::{Color, El, Icon, col, el, row, text};

use crate::app::App;
use crate::theme::{Theme, color_mix};
use crate::ui::kit::Dialog;
use crate::ui::{Btn, cover_art, css_border, font, ico, with_lh};

/// The picture beside the subject's name (`ConfirmArt`).
#[derive(Clone)]
pub enum Art {
    Cover { url: Option<String>, label: String },
    /// A person without a picture: their initials.
    Person(String),
    #[allow(dead_code)]
    Icon(&'static Icon),
}

/// What the action happens to (`ConfirmSubject`).
#[derive(Clone)]
pub struct Subject {
    pub art: Art,
    pub name: String,
    pub detail: Option<String>,
}

/// `ConfirmOptions`.
#[derive(Clone)]
pub struct ConfirmSpec {
    pub title: String,
    pub message: String,
    pub subject: Option<Subject>,
    pub confirm_label: String,
    pub confirm_icon: Option<&'static Icon>,
}

impl ConfirmSpec {
    pub fn new(title: impl Into<String>, message: impl Into<String>, confirm_label: impl Into<String>) -> ConfirmSpec {
        ConfirmSpec {
            title: title.into(),
            message: message.into(),
            subject: None,
            confirm_label: confirm_label.into(),
            confirm_icon: None,
        }
    }
    pub fn subject(mut self, art: Art, name: impl Into<String>, detail: Option<String>) -> ConfirmSpec {
        self.subject = Some(Subject { art, name: name.into(), detail });
        self
    }
    pub fn maybe_subject(mut self, subject: Option<Subject>) -> ConfirmSpec {
        self.subject = subject;
        self
    }
    pub fn icon(mut self, glyph: &'static Icon) -> ConfirmSpec {
        self.confirm_icon = Some(glyph);
        self
    }
}

type Answer = Box<dyn FnOnce(&mut App, bool)>;

/// The open question.
#[derive(Default)]
pub struct State {
    request: Option<(ConfirmSpec, Answer)>,
}

/// Ask `spec`; `answer` hears whether they went ahead. A newer question
/// answers the open one with no.
pub fn ask(app: &mut App, spec: ConfirmSpec, answer: impl FnOnce(&mut App, bool) + 'static) {
    if let Some((_, previous)) = app.pages.playlists.confirm.request.take() {
        previous(app, false);
    }
    app.pages.playlists.confirm.request = Some((spec, Box::new(answer)));
}

fn settle(app: &mut App, yes: bool) {
    if let Some((_, answer)) = app.pages.playlists.confirm.request.take() {
        answer(app, yes);
    }
}

fn subject_card(app: &App, t: &Theme, s: &Subject) -> El {
    let r = t.radius_md();
    let art = match &s.art {
        Art::Cover { url, label } => cover_art(t, &app.images, url.as_deref(), label, 48.0, 48.0, r),
        Art::Person(name) => el()
            .size(48.0, 48.0)
            .radius(r)
            .fill(t.c.muted)
            .center()
            .child(text(name.chars().take(2).collect::<String>().to_uppercase()).font(font(14.0, 500.0)).color(t.c.muted_foreground)),
        Art::Icon(g) => el().size(48.0, 48.0).radius(r).fill(t.c.muted).center().child(ico(g, 20.0, t.c.muted_foreground)),
    };
    let mut words = col()
        .grow(1.0)
        .min_w(0.0)
        .gap(2.0)
        .child(text(s.name.clone()).font(with_lh(font(14.0, 500.0), 18.2)).color(t.c.foreground).wrap_anywhere());
    if let Some(d) = &s.detail {
        words = words.child(text(d.clone()).font(with_lh(font(13.0, 400.0), 18.2)).color(t.c.muted_foreground).wrap_anywhere());
    }
    css_border(row(), 1.0, t.c.border, t.radius_lg())
        .w_full()
        .padding(11.0)
        .gap(12.0)
        .items_center()
        .radius(t.radius_lg())
        .fill(color_mix(t.c.muted, 0.5, Color::TRANSPARENT))
        .child(art)
        .child(words)
}

/// The open confirmation, if any.
pub fn view(app: &App, t: &Theme, window: [f32; 2]) -> Option<El> {
    let (spec, _) = app.pages.playlists.confirm.request.as_ref()?;
    let mut body = col().w_full().px(20.0).pt(20.0).pb(18.0).gap(16.0);
    if let Some(s) = &spec.subject {
        body = body.child(subject_card(app, t, s));
    }
    body = body.child(
        col()
            .w_full()
            .gap(6.0)
            .child(text(spec.title.clone()).font(with_lh(font(16.0, 600.0), 20.8).tracking(-0.16)).color(t.c.popover_foreground).wrap())
            .child(text(spec.message.clone()).font(with_lh(font(14.0, 400.0), 21.0)).color(t.c.muted_foreground).wrap()),
    );
    let mut go = Btn::new("playlist-confirm-go", spec.confirm_label.clone()).danger();
    if let Some(g) = spec.confirm_icon {
        go = go.icon_sized(g, 16.0);
    }
    let cancel = Btn::new("playlist-confirm-cancel", "Cancel").build(t).on_press(|a: &mut App| settle(a, false));
    let footer = crate::ui::css_border(row(), 0.0, Color::TRANSPARENT, 0.0)
        .child(el().pin(Some(0.0), Some(0.0), Some(0.0), None).h(1.0).fill(t.c.border).inert())
        .w_full()
        .px(16.0)
        .pt(13.0)
        .pb(12.0)
        .gap(8.0)
        .child(el().grow(1.0).child(cancel.w_full()))
        .child(el().grow(1.0).child(go.build(t).w_full().on_press(|a: &mut App| settle(a, true))));
    Some(
        Dialog::new("playlist-confirm", body)
            .max_width(400.0)
            .footer(footer)
            .build(t, window, |a: &mut App| settle(a, false))
            .role("alertdialog"),
    )
}
