//! The page's confirmations, drawn as `ConfirmDialog.tsx` (`confirm.css`)
//! draws `useConfirm`'s question: the subject as a card, the question and
//! what happens under it, Cancel and the action side by side.
//!
//! A stand-in for the shared confirm overlay (`overlays/confirm.rs`), behind
//! [`confirm`] so the page can switch to it in one place.

use std::rc::Rc;

use rune::{Color, Cx, El, Icon, col, el, row, text};

use crate::app::App;
use crate::theme::{Theme, color_mix};
use super::parts;
use crate::ui::{Btn, css_border, font, ico, kit, with_lh};

/// The picture beside the subject's name.
#[derive(Clone)]
pub enum ConfirmArt {
    /// A person without a picture: their first two letters.
    Person(String),
    Icon(&'static Icon),
}

#[derive(Clone)]
pub struct ConfirmSubject {
    pub art: ConfirmArt,
    pub name: String,
    pub detail: Option<String>,
}

/// One question: `ConfirmOptions` with what to do on yes.
#[derive(Clone)]
pub struct ConfirmRequest {
    pub title: String,
    pub message: String,
    pub subject: Option<ConfirmSubject>,
    pub confirm_label: String,
    pub confirm_icon: Option<&'static Icon>,
    pub on_confirm: Rc<dyn Fn(&mut App)>,
}

/// The open question, if any.
#[derive(Default)]
pub struct State {
    pub open: Option<ConfirmRequest>,
}

/// Ask before a destructive action; `request.on_confirm` runs if they go
/// ahead. A newer question replaces one still open (a no to that one).
pub fn confirm(app: &mut App, request: ConfirmRequest) {
    app.pages.admin.confirm.open = Some(request);
}

fn cancel(app: &mut App) {
    app.pages.admin.confirm.open = None;
}

fn go(app: &mut App) {
    if let Some(req) = app.pages.admin.confirm.open.take() {
        (req.on_confirm)(app);
    }
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let req = app.pages.admin.confirm.open.as_ref()?;
    let window = cx.layout_size("app").unwrap_or([1280.0, 820.0]);
    let inner = (window[0] - 32.0).min(400.0) - 42.0;
    let mut body = col().padding(20.0).pb(18.0).gap(16.0);
    if let Some(s) = &req.subject {
        body = body.child(subject_card(t, s, inner - 22.0 - 60.0));
    }
    body = body.child(
        col()
            .gap(6.0)
            .child(parts::para(&req.title, Vec::new(), with_lh(font(16.0, 600.0), 20.8).tracking(-0.16), t.c.popover_foreground, inner))
            .child(parts::para(&req.message, Vec::new(), with_lh(font(14.0, 400.0), 21.0), t.c.muted_foreground, inner)),
    );
    let mut danger = Btn::new("admin-confirm-go", req.confirm_label.clone()).danger().icon_size(16.0);
    if let Some(i) = req.confirm_icon {
        danger = danger.icon(i);
    }
    let footer = crate::ui::css_border(row(), 0.0, Color::TRANSPARENT, 0.0)
        .child(el().pin(Some(0.0), Some(0.0), Some(0.0), None).h(1.0).fill(t.c.border).inert())
        .px(16.0)
        .pt(13.0)
        .pb(12.0)
        .gap(8.0)
        .child(Btn::new("admin-confirm-cancel", "Cancel").build(t).grow(1.0).on_press(cancel))
        .child(danger.build(t).grow(1.0).on_press(go));
    Some(kit::Dialog::new("admin-confirm", body).max_width(400.0).footer(footer).build(t, window, cancel))
}

/// `.confirm-subject`.
fn subject_card(t: &Theme, s: &ConfirmSubject, text_w: f32) -> El {
    let tile = el().size(48.0, 48.0).radius(t.radius_md()).fill(t.c.muted).center();
    let tile = match &s.art {
        ConfirmArt::Person(name) => {
            let initials: String = name.chars().take(2).collect::<String>().to_uppercase();
            tile.child(text(initials).font(font(14.0, 500.0)).color(t.c.muted_foreground))
        }
        ConfirmArt::Icon(i) => tile.child(ico(i, 20.0, t.c.muted_foreground)),
    };
    let mut texts = col()
        .grow(1.0)
        .min_w(0.0)
        .gap(2.0)
        .child(parts::para(&s.name, Vec::new(), with_lh(font(14.0, 500.0), 18.2), t.c.popover_foreground, text_w));
    if let Some(d) = &s.detail {
        texts = texts.child(parts::para(d, Vec::new(), with_lh(font(13.0, 400.0), 18.2), t.c.muted_foreground, text_w));
    }
    css_border(row(), 1.0, t.c.border, t.radius_lg())
        .padding(11.0)
        .gap(12.0)
        .items_center()
        .radius(t.radius_lg())
        .fill(color_mix(t.c.muted, 0.5, Color::TRANSPARENT))
        .child(tile)
        .child(texts)
}
