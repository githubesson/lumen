//! `PendingInvites.tsx`, at `/invites`: invitations to other users'
//! collaborative playlists, to accept or decline.

use rune::{Cx, El, col, el, row, text};

use crate::api::{PendingInvite, error_message};
use crate::app::App;
use crate::format::fmt_date;
use crate::resource::{self, Res};
use crate::route::Location;
use crate::theme::Theme;
use crate::ui::blocks::{data_state, page_header};
use crate::ui::kit::surface;
use crate::ui::{Btn, ch, font, tnum};

/// What this page keeps between visits (`useApiResource` with the
/// `invites:pending` cache key: a revisit starts from the last list).
#[derive(Default)]
pub struct State {
    pub rows: Res<Vec<PendingInvite>>,
    pub action_error: Option<String>,
}

/// Runs on each navigation to the page: refresh the list.
pub fn enter(app: &mut App, _loc: &Location) {
    app.pages.invites.action_error = None;
    reload(app);
}

fn reload(app: &mut App) {
    resource::load(
        app,
        |app| Some(&mut app.pages.invites.rows),
        crate::api::playlists::list_pending_invites,
        "Failed to load invites.",
        |_| {},
    );
}

fn accept(app: &mut App, id: String) {
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || crate::api::playlists::accept_invite(&client, &id),
        |app, result| match result {
            Ok(()) => {
                app.load_playlists();
                reload(app);
            }
            Err(e) => app.pages.invites.action_error = Some(error_message(&e, "Failed to accept.")),
        },
    );
}

fn decline(app: &mut App, id: String) {
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || crate::api::playlists::decline_invite(&client, &id),
        |app, result| match result {
            Ok(()) => reload(app),
            Err(e) => app.pages.invites.action_error = Some(error_message(&e, "Failed to decline.")),
        },
    );
}

/// `PendingInviteRow`.
fn invite_row(t: &Theme, inv: &PendingInvite) -> El {
    let (a, d) = (inv.playlist_id.clone(), inv.playlist_id.clone());
    let detail = format!("{} invited you as {} · {}", inv.owner_name, inv.role, fmt_date(&inv.invited_at));
    crate::ui::css_border_top(row(), 1.0, t.c.border)
        .key(format!("invite-{}", inv.playlist_id))
        .w_full()
        .px(18.0)
        .pt(15.0)
        .pb(14.0)
        .gap(16.0)
        .items_center()
        .flex_wrap()
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
    let count = s.rows.data.as_ref().map_or("—".to_string(), |r| format!("{} pending", r.len()));
    let mut page = col()
        .key("invites-view")
        .w_full()
        .padding(t.pad())
        .child(page_header(t, "Playlist invites", Some(&count), None))
        .child(
            el().w_full().mt(8.0).max_w(ch(60.0, font(14.0, 400.0))).child(
                text("Other users can invite you to their collaborative playlists. Accepted playlists show up in your sidebar; declined invites are dismissed silently.")
                    .font(font(14.0, 400.0))
                    .color(t.c.muted_foreground)
                    .wrap()
                    .w_full(),
            ),
        );
    let error = s.action_error.as_deref().or(s.rows.error.as_deref());
    let rows = s.rows.data.as_deref();
    let empty = text("No pending invites.").font(font(14.0, 400.0)).color(t.c.muted_foreground).mt(4.0);
    let state = data_state(t, rows, error, None, Some((rows.is_some_and(|r| r.is_empty()), empty)), |rows| {
        let mut list = col().w_full();
        for inv in rows {
            list = list.child(invite_row(t, inv));
        }
        surface(t, 0.0).w_full().mt(4.0).clip_rounded(t.radius_xl()).child(list)
    })
    .mt(16.0);
    page = page.child(state);
    page
}
