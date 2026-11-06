//! `Admin.tsx` and `pages/admin/*`, at `/admin` (admins only): the Library,
//! Users and Invites sections, picked by `?section=`.
//!
//! The web app mounts one section's components at a time, so a section's
//! forms, sign-in flow and polling reset when it's left; the loaded data
//! (`useApiResource`'s cache) stays. [`enter`] does the same: a fresh visit or
//! a section switch "mounts" the section, and loops (rescan progress, the TIDAL
//! sign-in poll, pin re-scans) stop once their section is gone.

mod auto_download;
mod confirm;
mod delete_user;
mod format;
mod invites;
mod library;
mod parts;
mod pins;
mod remove_folder;
pub mod requests;
mod table;
mod tidal;
mod users;

use std::cell::Cell;

use rune::{Cx, El, col, text};

use crate::api::{ApiError, ApiResult, Client};
use crate::app::App;
use crate::route::Location;
use crate::theme::Theme;
use crate::ui::{font, kit, with_lh};

pub use confirm::{ConfirmArt, ConfirmRequest, ConfirmSubject, confirm};

/// `?section=`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Section {
    #[default]
    Library,
    Users,
    Invites,
}

impl Section {
    fn parse(v: Option<&str>) -> Section {
        match v {
            Some("users") => Section::Users,
            Some("invites") => Section::Invites,
            _ => Section::Library,
        }
    }
}

/// `useApiResource`: data that outlives a visit, the last load's error, and
/// whether a load is out.
#[derive(Clone, Debug)]
pub struct Res<T> {
    pub data: Option<T>,
    pub error: Option<String>,
    pub loading: bool,
    nonce: u64,
}

impl<T> Default for Res<T> {
    fn default() -> Self {
        Res { data: None, error: None, loading: false, nonce: 0 }
    }
}

/// What this page keeps between visits.
pub struct State {
    pub section: Section,
    pub library: library::State,
    pub tidal: tidal::State,
    pub auto: auto_download::State,
    pub pins: pins::State,
    pub users: users::State,
    pub invites: invites::State,
    pub confirm: confirm::State,
    /// The section mounted last, and the commit the page last drew in
    /// (a visit after another page mounts afresh).
    mounted: Option<Section>,
    seen: Cell<u64>,
    /// Bumped on each mount: loops started by an earlier mount stop.
    pub mount_id: u64,
}

impl Default for State {
    fn default() -> Self {
        State {
            section: Section::Library,
            library: Default::default(),
            tidal: Default::default(),
            auto: Default::default(),
            pins: Default::default(),
            users: Default::default(),
            invites: Default::default(),
            confirm: Default::default(),
            mounted: None,
            seen: Cell::new(u64::MAX),
            mount_id: 0,
        }
    }
}

/// `errorMessage(err, fallback)`: the server's message, else the fallback
/// (a request that never got an answer says nothing useful).
pub fn error_message(e: &ApiError, fallback: &str) -> String {
    let own = e.status != 0 || e.message.ends_with("Refresh sources or restart the backend.");
    if own && !e.message.is_empty() { e.message.clone() } else { fallback.to_string() }
}

/// Load `fetch` into the resource `lens` reaches, then run `then`.
pub fn load<T: Send + 'static>(
    app: &mut App,
    lens: fn(&mut App) -> &mut Res<T>,
    fetch: impl FnOnce(&Client) -> ApiResult<T> + Send + 'static,
    fallback: &'static str,
    then: impl FnOnce(&mut App) + Send + 'static,
) {
    let Some(client) = app.client.clone() else { return };
    let res = lens(app);
    res.nonce += 1;
    res.loading = true;
    res.error = None;
    let nonce = res.nonce;
    app.net.run(
        move || fetch(&client),
        move |app, result| {
            let res = lens(app);
            if res.nonce == nonce {
                res.loading = false;
                match result {
                    Ok(data) => res.data = Some(data),
                    Err(e) => res.error = Some(error_message(&e, fallback)),
                }
            }
            then(app);
        },
    )
}

/// Run `work` off the UI thread with the client, then `done` with its result.
pub fn call<T: Send + 'static>(
    app: &mut App,
    work: impl FnOnce(&Client) -> T + Send + 'static,
    done: impl FnOnce(&mut App, T) + Send + 'static,
) {
    let Some(client) = app.client.clone() else { return };
    app.net.run(move || work(&client), done);
}

/// Whether the page still shows `section` from mount `id` (a loop of an
/// unmounted section stops).
pub fn still_mounted(app: &App, section: Section, id: u64) -> bool {
    let st = &app.pages.admin;
    app.location().is("/admin") && st.section == section && st.mount_id == id
}

/// Runs on each navigation to the page: start its requests.
pub fn enter(app: &mut App, loc: &Location) {
    // The old per-section paths.
    let redirect = match loc.path.as_str() {
        "/admin/invites" => Some("/admin?section=invites"),
        "/admin/users" => Some("/admin?section=users"),
        "/admin/library" => Some("/admin"),
        _ => None,
    };
    if let Some(to) = redirect {
        app.navigate_replace(Location::parse(to));
        return;
    }
    if app.me().is_some_and(|me| me.role != crate::api::Role::Admin) {
        app.navigate_replace(Location::parse("/"));
        return;
    }
    let section = Section::parse(loc.get("section"));
    let st = &mut app.pages.admin;
    let fresh = st.seen.get() != rune::commit_generation();
    st.section = section;
    if fresh || st.mounted != Some(section) {
        st.mounted = Some(section);
        st.mount_id += 1;
        st.confirm = Default::default();
        match section {
            Section::Library => library::mount(app),
            Section::Users => users::mount(app),
            Section::Invites => invites::mount(app),
        }
    }
}

/// `setSection`: library is the bare path.
fn set_section(app: &mut App, s: Section) {
    let value = match s {
        Section::Library => None,
        Section::Users => Some("users"),
        Section::Invites => Some("invites"),
    };
    let loc = app.location().with("section", value);
    app.navigate_replace(loc);
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let st = &app.pages.admin;
    st.seen.set(rune::commit_generation());
    let pad = t.pad();
    // The width the sections lay out in (`.admin-section-wrap > *` keeps at
    // least 720 and scrolls sideways below that).
    let content_w = cx.layout_size("admin-view").map_or(956.0, |s| s[0] - 2.0 * pad);
    let inner_w = content_w.max(720.0);
    let section = match st.section {
        Section::Library => library::view(app, t, inner_w),
        Section::Users => users::view(app, t, inner_w),
        Section::Invites => invites::view(app, t, inner_w),
    };
    let mut wrap = col().key("admin-section-wrap").w_full().min_w(0.0).child(section.w(inner_w));
    if content_w < 720.0 {
        wrap = wrap.scroll_x();
    }
    if let Some(d) = confirm::view(app, t, cx) {
        kit::portal(d);
    }
    if let Some(d) = remove_folder::view(app, t, cx) {
        kit::portal(d);
    }
    if let Some(d) = delete_user::view(app, t, cx) {
        kit::portal(d);
    }
    col()
        .key("admin-view")
        .w_full()
        .min_w(0.0)
        .padding(pad)
        .gap(18.0)
        .child({
            let style = with_lh(font(30.0, 600.0), 43.5).tracking(-0.6);
            parts::line_box(text("Admin").font(style).color(t.c.foreground), style)
        })
        .child(
            col().items_start().child(kit::segmented(
                t,
                "admin-section",
                &[(Section::Library, "Library"), (Section::Users, "Users"), (Section::Invites, "Invites")],
                st.section,
                set_section,
            )),
        )
        .child(wrap)
}

/// Headless scenes: wait for the session (a late `/me` reply re-enters the
/// page and would remount it over the scene's state), then for the loads.
fn scene_ready(app: &mut App) {
    let start = std::time::Instant::now();
    while matches!(app.session, crate::app::Session::Loading) && start.elapsed() < std::time::Duration::from_secs(5) {
        std::thread::sleep(std::time::Duration::from_millis(5));
        crate::net::Net::drain(app);
    }
    app.settle_sync();
}

/// Scenes: set state the way an interaction would, after the page loaded.
pub mod scenes {
    /// Wait for the session and the page's data (`scene_ready`).
    pub fn ready(app: &mut crate::app::App) {
        super::scene_ready(app);
    }
    pub use super::delete_user::scene_open as delete_user;
    pub use super::invites::scene_created as invite_created;
    pub use super::library::{scene_errors_open as errors_open, scene_remove_folder as remove_folder};
    pub use super::tidal::{scene_flow as tidal_flow, scene_unlink as tidal_unlink};
    pub use super::auto_download::scene_downloads_open as downloads_open;
    pub use super::invites::{scene_past_open as invites_past, scene_revoke as revoke_invite};
    pub use super::users::scene_disable as disable_user;
}
