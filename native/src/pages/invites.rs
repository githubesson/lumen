//! `PendingInvites.tsx`, at `/invites`: invitations to other users'
//! collaborative playlists, to accept or decline.

use rune::{Cx, El, col, el, row, text};

use crate::api::PendingInvite;
use crate::app::App;
use crate::route::Location;
use crate::theme::Theme;
use crate::ui::kit::{error_banner, loading_state};
use crate::ui::{Btn, css_border, font, tnum};

use super::playlists::requests;

/// What this page keeps between visits (`useApiResource` with the
/// `invites:pending` cache key: a revisit starts from the last list).
#[derive(Default)]
pub struct State {
    pub rows: Option<Vec<PendingInvite>>,
    pub load_error: Option<String>,
    pub action_error: Option<String>,
    seq: u64,
}

/// Runs on each navigation to the page: refresh the list.
pub fn enter(app: &mut App, _loc: &Location) {
    app.pages.invites.action_error = None;
    reload(app);
}

fn reload(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let s = &mut app.pages.invites;
    s.seq += 1;
    s.load_error = None;
    let seq = s.seq;
    app.net.run(
        move || requests::list_pending_invites(&client),
        move |app, result| {
            let s = &mut app.pages.invites;
            if s.seq != seq {
                return;
            }
            match result {
                Ok(rows) => s.rows = Some(rows),
                Err(e) => s.load_error = Some(super::playlists::error_message(&e, "Failed to load invites.")),
            }
        },
    );
}

fn accept(app: &mut App, id: String) {
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || requests::accept_invite(&client, &id),
        |app, result| match result {
            Ok(()) => {
                app.load_playlists();
                reload(app);
            }
            Err(e) => app.pages.invites.action_error = Some(super::playlists::error_message(&e, "Failed to accept.")),
        },
    );
}

fn decline(app: &mut App, id: String) {
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || requests::decline_invite(&client, &id),
        |app, result| match result {
            Ok(()) => reload(app),
            Err(e) => app.pages.invites.action_error = Some(super::playlists::error_message(&e, "Failed to decline.")),
        },
    );
}

/// `PendingInviteRow`.
fn invite_row(t: &Theme, inv: &PendingInvite) -> El {
    let (a, d) = (inv.playlist_id.clone(), inv.playlist_id.clone());
    let detail = format!("{} invited you as {} · {}", inv.owner_name, inv.role, super::playlists::fmt_date(&inv.invited_at));
    row()
        .key(format!("invite-{}", inv.playlist_id))
        .w_full()
        .px(18.0)
        .pt(15.0)
        .pb(14.0)
        .gap(16.0)
        .items_center()
        .flex_wrap()
        .child(el().pin(Some(0.0), Some(0.0), Some(0.0), None).h(1.0).fill(t.c.border).inert())
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .child(text(inv.playlist_name.clone()).font(font(14.0, 500.0)).color(t.c.foreground).h(20.3))
                .child(text(detail).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground).h(17.4)),
        )
        .child(
            row()
                .gap(8.0)
                .child(Btn::new(format!("invite-accept-{a}"), "Accept").small().primary().build(t).on_press(move |app: &mut App| accept(app, a.clone())))
                .child(Btn::new(format!("invite-decline-{d}"), "Decline").small().ghost().build(t).on_press(move |app: &mut App| decline(app, d.clone()))),
        )
}

pub fn view(app: &App, t: &Theme, _cx: &mut Cx<App>) -> El {
    let s = &app.pages.invites;
    let count = s.rows.as_ref().map_or("—".to_string(), |r| format!("{} pending", r.len()));
    let mut page = col()
        .key("invites-view")
        .w_full()
        .padding(t.pad())
        .child(super::playlists::page_header(t, "Playlist invites", Some(&count), None))
        .child(
            el().w_full().mt(8.0).max_w(super::playlists::ch60(14.0)).child(
                text("Other users can invite you to their collaborative playlists. Accepted playlists show up in your sidebar; declined invites are dismissed silently.")
                    .font(font(14.0, 400.0))
                    .color(t.c.muted_foreground)
                    .wrap()
                    .w_full(),
            ),
        );
    let error = s.action_error.as_deref().or(s.load_error.as_deref());
    let mut state = col().w_full().mt(16.0);
    if let Some(e) = error {
        state = state.child(error_banner(t, e));
    }
    match &s.rows {
        None if error.is_none() => state = state.child(loading_state(t, "Loading…")),
        None => {}
        Some(rows) if rows.is_empty() => {
            state = state.child(text("No pending invites.").font(font(14.0, 400.0)).color(t.c.muted_foreground).mt(4.0))
        }
        Some(rows) => {
            let mut list = col().w_full();
            for inv in rows {
                list = list.child(invite_row(t, inv));
            }
            let r = t.radius_xl();
            state = state.child(css_border(col(), 1.0, t.c.border, r).w_full().mt(4.0).padding(1.0).radius(r).fill(t.c.card).clip_rounded(r).child(list));
        }
    }
    page = page.child(state);
    page
}
