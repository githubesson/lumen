//! `DeleteUserDialog.tsx`: a deleted user's playlists can't be left without
//! an owner, so each goes to someone else (their longest-standing
//! collaborator by default, else the admin deleting them) or is deleted.

use std::collections::HashMap;

use rune::{Cx, El, col, row, text};

use super::requests::{self as rq, AdminUser, Disposition, OwnedPlaylist, UserDeparturePreview};
use super::{Res, call, load, parts, users};
use crate::app::App;
use crate::theme::Theme;
use crate::ui::forms::{SelectOption, SelectVariant, select};
use crate::ui::{Btn, font, kit, line, tnum};

const DELETE: &str = "delete";
/// Joins a playlist id and its choice in one select value.
const SEP: char = '\u{1f}';

pub struct State {
    pub user: AdminUser,
    pub open: bool,
    pub preview: Res<UserDeparturePreview>,
    /// Only the choices the admin changed; the rest use their default.
    pub choices: HashMap<String, String>,
    pub busy: bool,
    pub error: Option<String>,
}

fn st(app: &mut App) -> Option<&mut State> {
    app.pages.admin.users.delete.as_mut()
}

fn preview_res(app: &mut App) -> &mut Res<UserDeparturePreview> {
    &mut app.pages.admin.users.delete.as_mut().expect("delete dialog").preview
}

/// Open a fresh dialog for `user` (its preview loads anew).
pub fn open(app: &mut App, user: AdminUser) {
    app.pages.admin.users.action_error = None;
    let id = user.id.clone();
    app.pages.admin.users.delete =
        Some(State { user, open: true, preview: Res::default(), choices: HashMap::new(), busy: false, error: None });
    load_preview(app, id);
}

fn load_preview(app: &mut App, id: String) {
    load(app, preview_res, move |c| rq::user_departure_preview(c, &id), "Couldn't load their playlists.", |_| {});
}

/// Ignored mid-request: the dialog is where its result or error shows up.
fn close(app: &mut App) {
    if let Some(s) = st(app) {
        if !s.busy {
            s.open = false;
        }
    }
}

/// Who can take a playlist: everyone else who isn't disabled.
fn heirs<'a>(users: &'a [AdminUser], user: &AdminUser) -> Vec<&'a AdminUser> {
    users.iter().filter(|u| u.id != user.id && !u.disabled).collect()
}

fn default_choice(heirs: &[&AdminUser], me: Option<&str>, p: &OwnedPlaylist) -> String {
    if let Some(h) = p.suggested_heir_id.as_deref().filter(|h| heirs.iter().any(|u| u.id == *h)) {
        return h.to_string();
    }
    if let Some(me) = me.filter(|m| heirs.iter().any(|u| u.id == *m)) {
        return me.to_string();
    }
    heirs.first().map_or(DELETE.to_string(), |u| u.id.clone())
}

fn choice_for(app: &App, s: &State, p: &OwnedPlaylist) -> String {
    if let Some(c) = s.choices.get(&p.playlist_id) {
        return c.clone();
    }
    let users = app.pages.admin.users.list.data.as_deref().unwrap_or(&[]);
    let me = app.me().map(|m| m.id.as_str());
    default_choice(&heirs(users, &s.user), me, p)
}

fn pick(app: &mut App, value: &str) {
    let Some((pid, choice)) = value.split_once(SEP) else { return };
    if let Some(s) = st(app) {
        s.choices.insert(pid.to_string(), choice.to_string());
    }
}

fn submit(app: &mut App) {
    let Some(s) = app.pages.admin.users.delete.as_ref() else { return };
    let Some(preview) = s.preview.data.as_ref() else { return };
    if s.busy {
        return;
    }
    let dispositions: Vec<Disposition> = preview
        .owned_playlists
        .iter()
        .map(|p| {
            let c = choice_for(app, s, p);
            Disposition { playlist_id: p.playlist_id.clone(), new_owner_id: (c != DELETE).then_some(c) }
        })
        .collect();
    let user = s.user.clone();
    if let Some(s) = st(app) {
        s.busy = true;
        s.error = None;
    }
    let id = user.id.clone();
    call(app, move |c| rq::delete_user(c, &id, &dispositions), move |app, r| {
        if let Some(s) = st(app) {
            s.busy = false;
        }
        match r {
            Ok(()) => {
                if let Some(s) = st(app) {
                    s.open = false;
                }
                users::reload(app);
            }
            Err(e) if e.status == 409 => {
                // They made a playlist since the preview loaded.
                if let Some(s) = st(app) {
                    s.error = Some("They own playlists that weren't listed yet. Check them below, then try again.".into());
                }
                load_preview(app, user.id.clone());
            }
            Err(e) => {
                if let Some(s) = st(app) {
                    s.error = Some(super::error_message(&e, &format!("Couldn't delete {}.", user.username)));
                }
            }
        }
    });
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let s = app.pages.admin.users.delete.as_ref().filter(|s| s.open)?;
    let users_list = app.pages.admin.users.list.data.as_deref()?;
    let me = app.me().map(|m| m.id.clone());
    let window = cx.layout_size("app").unwrap_or([1280.0, 820.0]);
    let inner = (window[0] - 32.0).min(512.0) - 34.0;
    let mut body = col().padding(16.0).gap(12.0);
    if let Some(e) = s.error.as_deref().or(s.preview.error.as_deref()) {
        body = body.child(parts::banner(t, e));
    }
    let style = font(14.0, 400.0);
    body = body.child(parts::para(
        "Their account, personal uploads, favorites and play history are removed. This can't be undone.",
        Vec::new(),
        style,
        t.c.popover_foreground,
        inner,
    ));
    if s.preview.data.is_none() && s.preview.error.is_none() {
        body = body.child(parts::line_box(text("Checking their playlists…").font(tnum(style)).color(t.c.muted_foreground), style));
    }
    let owned = s.preview.data.as_ref().map_or(&[][..], |p| &p.owned_playlists[..]);
    if !owned.is_empty() {
        let lead = if owned.len() == 1 {
            "They own a playlist. Choose what happens to it:".to_string()
        } else {
            format!("They own {} playlists. Choose what happens to each:", owned.len())
        };
        body = body.child(parts::para(&lead, Vec::new(), style, t.c.muted_foreground, inner));
        let hs = heirs(users_list, &s.user);
        let mut list = col().gap(8.0);
        for p in owned {
            let mut options: Vec<SelectOption> = hs
                .iter()
                .map(|u| {
                    let you = if Some(&u.id) == me.as_ref() { " (you)" } else { "" };
                    SelectOption::new(format!("{}{SEP}{}", p.playlist_id, u.id), format!("Give to {}{you}", u.username))
                })
                .collect();
            options.push(SelectOption::new(format!("{}{SEP}{DELETE}", p.playlist_id), "Delete playlist"));
            let value = format!("{}{SEP}{}", p.playlist_id, choice_for(app, s, p));
            let control = select(
                app,
                t,
                &format!("admin-delete-choice-{}", p.playlist_id),
                &options,
                &value,
                SelectVariant::Native,
                "",
                s.busy,
                pick,
            )
            .label(format!("What happens to {}", p.name));
            list = list.child(
                row()
                    .gap(12.0)
                    .items_center()
                    .child(line(p.name.clone(), style, t.c.popover_foreground).help(p.name.clone()).grow(1.0).min_w(0.0))
                    .child(control.w(220.0)),
            );
        }
        body = body.child(list);
    }
    let cancel = Btn::new("admin-delete-cancel", "Cancel").ghost().disabled(s.busy).build(t);
    let cancel = if s.busy { cancel } else { cancel.on_press(close) };
    let can = !s.busy && s.preview.data.is_some();
    let label = if s.busy { "Deleting…".to_string() } else { format!("Delete {}", s.user.username) };
    let go = Btn::new("admin-delete-go", label).danger().disabled(!can).build(t);
    let go = if can { go.on_press(submit) } else { go };
    Some(
        kit::Dialog::new("admin-delete-dialog", body)
            .title(format!("Delete {}?", s.user.username))
            .footer(kit::dialog_footer(t, None, vec![cancel, go]))
            .build(t, window, close),
    )
}

/// Scene: deleting jonas, who owns two playlists.
pub fn scene_open(app: &mut App) {
    let Some(u) = app.pages.admin.users.list.data.as_ref().and_then(|l| l.iter().find(|u| u.username == "jonas")).cloned() else {
        return;
    };
    open(app, u);
    // The mock's preview (none) lands first; the scene's goes over it.
    super::scenes::ready(app);
    if let Some(s) = st(app) {
        s.preview.data = Some(UserDeparturePreview {
            owned_playlists: vec![
                OwnedPlaylist {
                    playlist_id: "pl-jonas-running".into(),
                    name: "Jonas's Running Mix — 170 BPM and Up".into(),
                    suggested_heir_id: Some("u-priya".into()),
                },
                OwnedPlaylist { playlist_id: "pl-jonas-focus".into(), name: "Deep Focus".into(), suggested_heir_id: None },
            ],
        });
        s.preview.error = None;
    }
}
