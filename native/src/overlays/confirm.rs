//! `context/Confirm.tsx`, `ConfirmDialog.tsx` (`confirm.css`): the one
//! app-wide question before a destructive action, shaped like the share
//! page's card: the subject as a card, the question under it, and the two
//! answers side by side along the bottom.
//!
//! Ask with [`ask`] (answer either way), [`ask_then`] (only a yes), or
//! [`ask_action`], which runs the action from the dialog: it stays open and
//! busy until the request settles and shows the error if it fails, so the
//! answer is only yes once it has succeeded.

use rune::{Color, Cx, El, Icon, col, el, row, text};

use crate::api::{ApiError, Client};
use crate::app::App;
use crate::theme::{Theme, color_mix};
use crate::ui::kit::{Dialog, error_banner};
use crate::ui::{Btn, cover_art, css_border, font, ico, with_lh};

/// The picture beside the subject's name (`ConfirmArt`).
#[derive(Clone)]
pub enum Art {
    /// A cover at `url` (None draws the label's initial).
    Cover { url: Option<String>, label: String },
    /// A person without a picture: their initials, as the sidebar shows them.
    Person(String),
    Icon(&'static Icon),
}

/// What the action happens to (`ConfirmSubject`): its art, name and a detail.
#[derive(Clone)]
pub struct Subject {
    pub art: Art,
    pub name: String,
    /// Artist · album, a track count, where it's from.
    pub detail: Option<String>,
}

/// `ConfirmOptions`.
#[derive(Clone)]
pub struct ConfirmSpec {
    /// The question, short: "Delete this playlist?".
    pub title: String,
    /// What happens if they go ahead, in a sentence.
    pub message: String,
    pub subject: Option<Subject>,
    /// The confirming button, a verb for what it does ("Delete").
    pub confirm_label: String,
    pub confirm_icon: Option<&'static Icon>,
    /// The confirming button while an action runs ("Deleting…").
    pub busy_label: Option<String>,
    /// Shown when the action fails without a message of its own.
    pub error_fallback: Option<String>,
    /// The confirming button is `.btn-danger` (every confirm in the web app);
    /// false makes it primary.
    pub danger: bool,
}

impl ConfirmSpec {
    pub fn new(title: impl Into<String>, message: impl Into<String>, confirm_label: impl Into<String>) -> ConfirmSpec {
        ConfirmSpec {
            title: title.into(),
            message: message.into(),
            subject: None,
            confirm_label: confirm_label.into(),
            confirm_icon: None,
            busy_label: None,
            error_fallback: None,
            danger: true,
        }
    }
    pub fn subject(mut self, art: Art, name: impl Into<String>, detail: Option<String>) -> ConfirmSpec {
        self.subject = Some(Subject { art, name: name.into(), detail });
        self
    }
    /// [`ConfirmSpec::subject`] when there is one.
    pub fn maybe_subject(mut self, subject: Option<Subject>) -> ConfirmSpec {
        self.subject = subject;
        self
    }
    pub fn icon(mut self, glyph: &'static Icon) -> ConfirmSpec {
        self.confirm_icon = Some(glyph);
        self
    }
    pub fn busy_label(mut self, label: impl Into<String>) -> ConfirmSpec {
        self.busy_label = Some(label.into());
        self
    }
    pub fn error_fallback(mut self, message: impl Into<String>) -> ConfirmSpec {
        self.error_fallback = Some(message.into());
        self
    }
}

type Answer = Box<dyn FnOnce(&mut App, bool)>;
type Action = Box<dyn FnOnce(&Client) -> Result<(), ApiError> + Send>;

struct Request {
    id: u64,
    spec: ConfirmSpec,
    answer: Option<Answer>,
    action: Option<Action>,
}

/// The open question, if any.
#[derive(Default)]
pub struct State {
    request: Option<Request>,
    next_id: u64,
    busy: bool,
    error: Option<String>,
}

impl State {
    pub fn is_open(&self) -> bool {
        self.request.is_some()
    }
}

/// Ask `spec`; `answer` hears true (go ahead) or false (cancelled, or
/// replaced by a newer question).
pub fn ask(app: &mut App, spec: ConfirmSpec, answer: impl FnOnce(&mut App, bool) + 'static) {
    open(app, spec, Some(Box::new(answer)), None);
}

/// Ask `spec` and run `on_confirm` only when they go ahead.
pub fn ask_then(app: &mut App, spec: ConfirmSpec, on_confirm: impl FnOnce(&mut App) + 'static) {
    ask(app, spec, move |app, yes| {
        if yes {
            on_confirm(app)
        }
    });
}

/// Ask `spec`, and on yes run `action` (a request, off the UI thread) from
/// the dialog. It stays open and busy until the action settles; a failure
/// shows in the dialog, and only success closes it and calls `on_done`.
pub fn ask_action(
    app: &mut App,
    spec: ConfirmSpec,
    action: impl FnOnce(&Client) -> Result<(), ApiError> + Send + 'static,
    on_done: impl FnOnce(&mut App) + 'static,
) {
    let answer: Answer = Box::new(move |app, yes| {
        if yes {
            on_done(app)
        }
    });
    open(app, spec, Some(answer), Some(Box::new(action)));
}

fn open(app: &mut App, spec: ConfirmSpec, answer: Option<Answer>, action: Option<Action>) {
    // A newer question replaces one still open, which counts as a no.
    if let Some(mut old) = app.overlays.confirm.request.take()
        && let Some(a) = old.answer.take()
    {
        a(app, false);
    }
    let s = &mut app.overlays.confirm;
    s.next_id += 1;
    s.busy = false;
    s.error = None;
    s.request = Some(Request { id: s.next_id, spec, answer, action });
}

fn settle(app: &mut App, id: u64, yes: bool) {
    let s = &mut app.overlays.confirm;
    if s.request.as_ref().is_none_or(|r| r.id != id) {
        return;
    }
    let mut request = s.request.take().expect("checked above");
    s.busy = false;
    s.error = None;
    if let Some(a) = request.answer.take() {
        a(app, yes);
    }
}

/// Cancel: ignored mid-action, the dialog is where its result shows up.
fn cancel(app: &mut App) {
    let s = &app.overlays.confirm;
    if s.busy {
        return;
    }
    if let Some(id) = s.request.as_ref().map(|r| r.id) {
        settle(app, id, false);
    }
}

fn go(app: &mut App) {
    let s = &mut app.overlays.confirm;
    if s.busy {
        return;
    }
    let Some(request) = s.request.as_mut() else { return };
    let id = request.id;
    let Some(action) = request.action.take() else {
        settle(app, id, true);
        return;
    };
    let fallback = request.spec.error_fallback.clone().unwrap_or_else(|| "Something went wrong.".into());
    s.busy = true;
    s.error = None;
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || action(&client),
        move |app, result| {
            let s = &mut app.overlays.confirm;
            if s.request.as_ref().is_none_or(|r| r.id != id) {
                return;
            }
            match result {
                Ok(()) => settle(app, id, true),
                Err(e) => {
                    s.busy = false;
                    s.error = Some(if e.message.is_empty() || e.status == 0 { fallback } else { e.message });
                    // Let them try again.
                    if let Some(r) = s.request.as_mut() {
                        r.action = None;
                    }
                }
            }
        },
    );
}

/// `SubjectCard`.
fn subject_card(app: &App, t: &Theme, subject: &Subject) -> El {
    let r = t.radius_md();
    let art = match &subject.art {
        Art::Cover { url, label } => cover_art(t, &app.images, url.as_deref(), label, 48.0, 48.0, r),
        Art::Person(name) => {
            let initials: String = name.chars().take(2).collect::<String>().to_uppercase();
            el().size(48.0, 48.0)
                .radius(r)
                .fill(t.c.muted)
                .center()
                .child(text(initials).font(font(14.0, 500.0)).color(t.c.muted_foreground))
        }
        Art::Icon(glyph) => el().size(48.0, 48.0).radius(r).fill(t.c.muted).center().child(ico(glyph, 20.0, t.c.muted_foreground)),
    };
    let mut words = col()
        .grow(1.0)
        .min_w(0.0)
        .gap(2.0)
        .child(crate::ui::snug_lines(
            "confirm-subject-name",
            text(subject.name.clone()).font(with_lh(font(14.0, 500.0), 18.2)).color(t.c.foreground).wrap_anywhere(),
            18.2,
        ));
    if let Some(d) = &subject.detail {
        words = words.child(crate::ui::snug_lines(
            "confirm-subject-detail",
            text(d.clone()).font(with_lh(font(13.0, 400.0), 18.2)).color(t.c.muted_foreground).wrap_anywhere(),
            18.2,
        ));
    }
    css_border(row(), 1.0, t.c.border, t.radius_lg())
        .key("confirm-subject")
        .w_full()
        .min_w(0.0)
        .padding(11.0)
        .gap(12.0)
        .items_center()
        .radius(t.radius_lg())
        .fill(color_mix(t.c.muted, 0.5, Color::TRANSPARENT))
        .child(art)
        .child(words)
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let s = &app.overlays.confirm;
    let request = s.request.as_ref()?;
    let spec = &request.spec;
    let window = crate::overlays::window_size(cx);

    let mut body = col().key("confirm-body").w_full().gap(16.0).pt(20.0).px(20.0).pb(18.0);
    if let Some(subject) = &spec.subject {
        body = body.child(subject_card(app, t, subject));
    }
    body = body.child(
        col()
            .w_full()
            .gap(6.0)
            .child(crate::ui::snug_lines(
                "confirm-title",
                text(spec.title.clone())
                    .font(with_lh(font(16.0, 600.0), 20.8).tracking(-0.16))
                    .color(t.c.popover_foreground)
                    .wrap_anywhere()
                    .role("heading"),
                20.8,
            ))
            .child(text(spec.message.clone()).font(with_lh(font(14.0, 400.0), 21.0)).color(t.c.muted_foreground).wrap_anywhere()),
    );
    if let Some(e) = &s.error {
        body = body.child(error_banner(t, e));
    }

    let label = if s.busy { spec.busy_label.clone().unwrap_or_else(|| spec.confirm_label.clone()) } else { spec.confirm_label.clone() };
    let mut confirm = Btn::new("confirm-go", label).disabled(s.busy);
    confirm = if spec.danger { confirm.danger() } else { confirm.primary() };
    if let Some(g) = spec.confirm_icon {
        confirm = confirm.icon(g).icon_size(16.0);
    }
    let footer = row()
        .key("confirm-actions")
        .w_full()
        .gap(8.0)
        .px(16.0)
        .pt(13.0)
        .pb(12.0)
        .child(el().pin(Some(0.0), Some(0.0), Some(0.0), None).h(1.0).fill(t.c.border).inert())
        .child(el().grow(1.0).w(0.0).child(Btn::new("confirm-cancel", "Cancel").disabled(s.busy).build(t).w_full().on_press(cancel)))
        .child(el().grow(1.0).w(0.0).child(confirm.build(t).w_full().on_press(go)));
    Some(
        Dialog::new("confirm", body)
            .max_width(400.0)
            .footer(footer)
            .build(t, window, cancel)
            .role("alertdialog"),
    )
}
