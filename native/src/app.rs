//! The app's state and root view: `App.tsx`, the providers in `main.tsx`,
//! and the desktop bridge's state that lived in Electron's main process.

use rune::{Color, Cx, El, KeyEvent, Tx, Waker, col};

use crate::api::{self, Client, Me, Playlist};
use crate::resource::Res;
use crate::config::{Config, Tweaks};
use crate::images::Images;
use crate::net::{LateWaker, Net};
use crate::route::{History, Location};
use crate::theme::{Mode, Theme};

/// `useAuth().status` with its user.
#[derive(Clone, Debug, PartialEq)]
pub enum Session {
    /// Waiting on `/api/auth/me`.
    Loading,
    SignedOut,
    SignedIn(Me),
    /// `/me` failed for another reason than 401 (the server is unreachable).
    Unreachable(String),
}

/// Overlays and panels the shell opens.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Ui {
    pub palette_open: bool,
    pub settings_open: bool,
    pub upload_open: bool,
    pub lyrics_open: bool,
    pub pane_drag: Option<crate::shell::panes::DragState>,
    /// The sidebar drawer of narrow windows (`useMobileNav`).
    pub mobile_nav_open: bool,
    /// A `SeekBar` being dragged: its key and the value under the pointer.
    pub seek_drag: Option<(String, f32)>,
    /// The player's popovers, lyrics state and mini player mode.
    pub player: crate::shell::player::State,
}

pub struct App {
    pub config: Config,
    pub tweaks: Tweaks,
    /// The OS appearance, used until the user picks a theme.
    pub system_dark: std::cell::Cell<bool>,
    /// The next commit lands at once (a navigation, data arriving): the web
    /// app swaps pages and shows loaded data without any transition.
    pub instant_once: std::cell::Cell<bool>,
    pub waker: LateWaker,
    pub net: Net,
    pub images: Images,
    pub client: Option<Client>,
    pub session: Session,
    pub history: History,
    /// `usePlaylists()` (`context/Playlists.tsx`): the user's playlists,
    /// None until loaded; [`App::load_playlists`] is its `reload`,
    /// `pages::playlists::update_playlists` its `update`.
    pub playlists: Res<Vec<Playlist>>,
    pub pending_invites: usize,
    pub ui: Ui,
    pub player: crate::player::Player,
    pub pages: crate::pages::Pages,
    pub overlays: crate::overlays::Overlays,
    /// The open `<Select>` listbox, if any.
    pub select: Option<crate::ui::forms::OpenSelect>,
    /// The shared components' state (selections, tooltips, shelves).
    pub widgets: crate::ui::Widgets,
    /// What Electron's main process did: presence, the now-playing API, updates.
    pub desktop: crate::desktop::Desktop,
}

impl App {
    pub fn new() -> App {
        let config = Config::load();
        let waker = LateWaker::default();
        let net = Net::new(waker.clone());
        let images = Images::new(waker.clone());
        let tweaks = config.tweaks.clone().unwrap_or_default();
        let mut app = App {
            tweaks,
            system_dark: std::cell::Cell::new(true),
            instant_once: std::cell::Cell::new(false),
            images,
            net,
            client: None,
            session: Session::Loading,
            history: History::new(Location::parse("/")),
            playlists: Res::default(),
            pending_invites: 0,
            ui: Ui::default(),
            player: crate::player::Player::new(waker.clone(), config.audio_sink_id.clone()),
            pages: crate::pages::Pages::default(),
            overlays: crate::overlays::Overlays::default(),
            select: None,
            widgets: crate::ui::Widgets::default(),
            desktop: crate::desktop::Desktop::default(),
            config,
            waker,
        };
        let server = std::env::var("LUMEN_SERVER").ok().or_else(|| app.config.backend_url.clone());
        if let Some(server) = server {
            app.connect(&server);
        }
        app
    }

    /// Point the app at `server` and check the session (`AuthProvider`).
    pub fn connect(&mut self, server: &str) {
        let jar = crate::config::data_dir().join("session.json");
        let client = Client::new(server, Some(jar));
        // A request the server rejects with 401 ends the session (`setUnauthorizedHandler`).
        let sender = self.net.sender();
        client.on_unauthorized(move || {
            sender.send(|app: &mut App| {
                if matches!(app.session, Session::SignedIn(_)) {
                    app.signed_out();
                }
            })
        });
        self.images.set_client(Some(client.clone()));
        self.client = Some(client);
        self.session = Session::Loading;
        self.refresh_me();
    }

    /// `refresh()`: re-check the session (`pages::auth::session`).
    pub fn refresh_me(&mut self) {
        crate::pages::auth::session::refresh(self);
    }

    /// A session landed (`/me`, sign-in, registration): the shell's data,
    /// and the route `App.tsx` sends this user to.
    pub fn signed_in(&mut self, me: Me) {
        let forced = me.must_reset_password;
        self.session = Session::SignedIn(me);
        if forced {
            // A forced reset loads nothing until the new password is set.
            self.playlists.set(Vec::new());
            self.pending_invites = 0;
        } else {
            self.load_playlists();
            self.load_pending_invites();
            crate::pages::favorites::refresh(self);
        }
        let at = self.location().path.clone();
        if at == "/login" {
            // `<Navigate to="/" replace />`, and "/" forwards a forced reset.
            let to = if forced { "/reset-password" } else { "/" };
            self.navigate_replace(Location::parse(to));
        } else if forced && at == "/" {
            self.navigate_replace(Location::parse("/reset-password"));
        } else {
            let loc = self.location().clone();
            crate::pages::enter(self, &loc);
        }
    }

    pub fn me(&self) -> Option<&Me> {
        match &self.session {
            Session::SignedIn(me) => Some(me),
            _ => None,
        }
    }

    /// `usePlaylists().reload()`: only the newest read commits, and none that
    /// an `update` overtook (`useApiResource`).
    pub fn load_playlists(&mut self) {
        self.load_playlists_then(|_| {});
    }

    /// [`App::load_playlists`], then `then` once the read settles.
    pub fn load_playlists_then(&mut self, then: impl FnOnce(&mut App) + Send + 'static) {
        if self.client.is_none() {
            return;
        }
        if self.me().is_some_and(|me| me.must_reset_password) {
            self.playlists.set(Vec::new());
            return;
        }
        crate::resource::load(
            self,
            |app| Some(&mut app.playlists),
            |c| api::playlists::list_playlists(c, None),
            "Could not load playlists.",
            then,
        );
    }

    fn load_pending_invites(&mut self) {
        let Some(client) = self.client.clone() else { return };
        self.net.run(
            move || api::playlists::list_pending_invites(&client),
            |app, result| {
                if let Ok(list) = result {
                    app.pending_invites = list.len();
                }
            },
        );
    }

    pub fn location(&self) -> &Location {
        self.history.current()
    }

    /// Follow a link (`navigate(to)`).
    pub fn navigate(&mut self, loc: Location) {
        self.instant_once.set(true);
        self.history.push(loc.clone());
        crate::pages::enter(self, &loc);
    }

    pub fn navigate_to(&mut self, href: &str) {
        self.navigate(Location::parse(href));
    }

    /// `navigate(to, { replace: true })`.
    pub fn navigate_replace(&mut self, loc: Location) {
        self.instant_once.set(true);
        self.history.replace(loc.clone());
        crate::pages::enter(self, &loc);
    }

    pub fn back(&mut self) {
        self.instant_once.set(true);
        if self.history.back() {
            let loc = self.location().clone();
            crate::pages::enter(self, &loc);
        }
    }

    /// The theme the view draws in.
    pub fn theme(&self) -> Theme {
        let mode = if self.config.tweaks.is_some() {
            self.tweaks.theme
        } else if self.system_dark.get() {
            Mode::Dark
        } else {
            Mode::Light
        };
        Theme::new(mode, self.tweaks.radius, self.tweaks.density, self.tweaks.layout)
    }

    /// Save a tweak (`saveTweaks`): it applies at once and lands in config.json.
    pub fn set_tweaks(&mut self, f: impl FnOnce(&mut Tweaks)) {
        if self.config.tweaks.is_none() {
            // The first save fixes the theme the OS gave.
            self.tweaks.theme = self.theme().mode;
        }
        f(&mut self.tweaks);
        self.config.tweaks = Some(self.tweaks.clone());
        self.config.save();
    }

    pub fn toggle_theme(&mut self) {
        let next = self.theme().mode.toggled();
        self.set_tweaks(|t| t.theme = next);
    }

    pub fn toggle_sidebar(&mut self) {
        use crate::theme::Layout;
        let next = if self.tweaks.layout == Layout::Compact { Layout::Sidebar } else { Layout::Compact };
        self.set_tweaks(|t| t.layout = next);
    }

    /// `logout()` (`pages::auth::session`).
    pub fn sign_out(&mut self) {
        self.player.stop();
        crate::pages::auth::session::logout(self);
    }

    /// Signed out: drop what the session showed and start at `/login`.
    pub fn signed_out(&mut self) {
        // A late 401 from the old session must not end the next one.
        if let Some(client) = &self.client {
            client.advance_auth_generation();
        }
        self.session = Session::SignedOut;
        self.forget_session("/login");
        crate::pages::enter(self, &Location::parse("/login"));
    }

    /// Another server (Welcome, Settings): what Electron's `config:update`
    /// does before reloading the window there. The old server's cookies go,
    /// what its session showed goes, and the app connects to `url`.
    pub fn switch_server(&mut self, url: &str) {
        if let Some(old) = &self.client {
            old.clear_cookies();
        }
        self.forget_session("/");
        self.connect(url);
    }

    /// Drop what a session showed: the player's queue, the shell's data,
    /// every page's state, and the history (which starts again at `at`).
    fn forget_session(&mut self, at: &str) {
        self.player.stop();
        self.playlists = Res::default();
        self.pending_invites = 0;
        self.pages = Default::default();
        self.history = History::new(Location::parse(at));
    }

    /// Load everything a scene shows before its first frame (headless only).
    pub fn settle_sync(&mut self) {
        self.net.set_sync(true);
        self.images.set_sync(true);
        while Net::drain(self) {}
    }
}

fn init() -> App {
    App::new()
}

fn setup(app: &mut App, waker: Waker) {
    app.waker.set(waker);
}

fn poll(app: &mut App, clock: f64, tx: &mut Tx) -> bool {
    let mut changed = Net::drain(app);
    if changed {
        // Loaded data shows at once, as the web app renders it.
        tx.instant();
    }
    // A cover arrived: the view swaps its placeholder for it.
    changed |= app.images.take_arrived();
    changed |= crate::player::poll(app, tx);
    changed |= crate::ui::poll(app, clock, tx);
    changed |= crate::pages::playlists::sync(app);
    changed |= crate::desktop::poll(app);
    changed |= crate::pages::auth::poll(app, clock, tx);
    changed |= crate::pages::share_preview::poll(app, clock, tx);
    // Overlay work that finished off the UI thread and needs a `Tx` (a copy, a save dialog).
    changed |= crate::overlays::poll(app, tx);
    changed |= crate::shell::player::poll(app, clock, tx);
    changed |= crate::shell::panes::poll(app);
    changed
}

fn on_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    crate::keys::on_key(app, ev, tx)
}

pub fn view(app: &App, cx: &mut Cx<App>) -> El {
    app.system_dark.set(cx.system_dark());
    app.images.set_scale(cx.env().scale);
    app.widgets.lists.begin_frame();
    let t = app.theme();
    // `App.tsx`'s gating: the shell only for a signed-in route.
    let in_shell = crate::pages::auth::gate(app) == crate::pages::auth::Gate::Shell;
    let body = if in_shell { crate::shell::view(app, &t, cx) } else { crate::pages::signed_out(app, &t, cx) };
    // Motion as the CSS has it: layout and colour changes take a short
    // ease-out (Rune's default spring runs 0.5 s; the web's transitions are
    // 120–280 ms, and most changes have none), hover fades 120 ms.
    let mut root = col()
        .key("root")
        .w_full()
        .h_full()
        .fill(Color::TRANSPARENT)
        .motion(crate::ui::motion::LAYOUT)
        .hover_motion_within(crate::ui::motion::ease(120.0), crate::ui::motion::ease(120.0))
        .child(body);
    if in_shell {
        for layer in crate::overlays::view(app, &t, cx) {
            root = root.child(layer);
        }
    }
    if app.instant_once.replace(false) {
        root = root.instant_changes();
    }
    root
}

/// Scenes for headless snapshots: each signs in against `LUMEN_SERVER` (the
/// mock server by default) and opens one screen with its data loaded.
pub(crate) fn scene(app: &mut App, path: &str) {
    // Synchronous first, so the session check lands before the first frame
    // (one started at launch, still on a worker, no longer counts).
    app.settle_sync();
    if app.client.is_none() {
        app.connect(&std::env::var("LUMEN_SERVER").unwrap_or_else(|_| "http://127.0.0.1:4791".into()));
    } else {
        app.refresh_me();
    }
    app.settle_sync();
    app.navigate(Location::parse(path));
    crate::player::scene_loaded_track(app);
    app.settle_sync();
}

/// A Home scene on a saved arrangement (`tweaks.homeBoard`), seeded before
/// sign-in as the reference seeds it, without touching config.json.
fn home_scene(app: &mut App, board: &str, path: &str) {
    app.tweaks.home_board = serde_json::from_str(board).ok();
    scene(app, path);
}

pub const SCENES: &[(&str, fn(&mut App))] = &[
    ("home", |a| scene(a, "/")),
    ("home-medium", |a| scene(a, "/")),
    ("home-narrow", |a| scene(a, "/")),
    ("home-customize", |a| scene(a, "/?customize")),
    ("home-swapped", |a| home_scene(a, crate::pages::home::scenes::SWAPPED, "/")),
    ("home-custom", |a| home_scene(a, crate::pages::home::scenes::CUSTOM, "/")),
    ("home-empty", |a| home_scene(a, crate::pages::home::scenes::HIDDEN, "/")),
    ("home-custom-customize", |a| home_scene(a, crate::pages::home::scenes::CUSTOM, "/?customize")),
    ("home-add", |a| {
        home_scene(a, crate::pages::home::scenes::CUSTOM, "/?customize");
        crate::pages::home::dialogs::open_add(a);
    }),
    ("home-settings", |a| {
        home_scene(a, crate::pages::home::scenes::CUSTOM, "/?customize");
        crate::pages::home::dialogs::open_settings(a, "repeat", Some("activity".into()));
    }),
    ("home-reset", |a| {
        home_scene(a, crate::pages::home::scenes::CUSTOM, "/?customize");
        crate::pages::home::editing::reset_board(a);
    }),
    ("library", |a| scene(a, "/library")),
    ("albums", |a| scene(a, "/library?view=albums")),
    ("artists", |a| scene(a, "/library?view=artists")),
    ("favorites", |a| scene(a, "/favorites")),
    ("recent", |a| scene(a, "/recent")),
    ("playlists", |a| scene(a, "/playlists")),
    ("playlist-owned", |a| scene(a, "/playlists/pl-night-drives")),
    ("playlist-collab", |a| scene(a, "/playlists/pl-sunday-coffee")),
    ("playlist-shared", |a| scene(a, "/playlists/pl-road-trip")),
    ("playlist-collaborators", |a| {
        scene(a, "/playlists/pl-sunday-coffee");
        crate::pages::playlists::scene(a, "collaborators");
    }),
    ("playlist-shared-collaborators", |a| {
        scene(a, "/playlists/pl-road-trip");
        crate::pages::playlists::scene(a, "collaborators");
    }),
    ("playlist-settings", |a| {
        scene(a, "/playlists/pl-sunday-coffee");
        crate::pages::playlists::scene(a, "settings");
    }),
    ("playlist-shared-settings", |a| {
        scene(a, "/playlists/pl-road-trip");
        crate::pages::playlists::scene(a, "settings");
    }),
    ("playlist-add", |a| {
        scene(a, "/playlists/pl-night-drives");
        crate::pages::playlists::scene(a, "add");
    }),
    ("playlist-drag", |a| {
        scene(a, "/playlists/pl-night-drives");
        crate::pages::playlists::scene(a, "drag");
    }),
    ("playlist-new", |a| scene(a, "/playlists/new")),
    ("invites", |a| scene(a, "/invites")),
    ("replay", |a| scene(a, "/replay")),
    ("admin", |a| {
        scene(a, "/admin");
        crate::pages::admin::scenes::ready(a);
    }),
    // The admin page's sections and dialogs (scroll the library ones with
    // a `--script` wheel, as the reference scrolls `.content`).
    ("admin-users", |a| {
        scene(a, "/admin?section=users");
        crate::pages::admin::scenes::ready(a);
    }),
    ("admin-invites", |a| {
        scene(a, "/admin?section=invites");
        crate::pages::admin::scenes::ready(a);
    }),
    ("admin-errors", |a| {
        scene(a, "/admin");
        crate::pages::admin::scenes::ready(a);
        crate::pages::admin::scenes::errors_open(a);
    }),
    ("admin-downloads", |a| {
        scene(a, "/admin");
        crate::pages::admin::scenes::ready(a);
        crate::pages::admin::scenes::downloads_open(a);
    }),
    ("admin-pin-history", |a| {
        scene(a, "/admin");
        crate::pages::admin::scenes::ready(a);
        crate::pages::admin::scenes::pin_history(a);
    }),
    ("admin-remove-folder", |a| {
        scene(a, "/admin");
        crate::pages::admin::scenes::ready(a);
        crate::pages::admin::scenes::remove_folder(a);
    }),
    ("admin-unlink", |a| {
        scene(a, "/admin");
        crate::pages::admin::scenes::ready(a);
        crate::pages::admin::scenes::tidal_unlink(a);
    }),
    ("admin-link-flow", |a| {
        scene(a, "/admin");
        crate::pages::admin::scenes::ready(a);
        crate::pages::admin::scenes::tidal_flow(a);
    }),
    ("admin-disable-user", |a| {
        scene(a, "/admin?section=users");
        crate::pages::admin::scenes::ready(a);
        crate::pages::admin::scenes::disable_user(a);
    }),
    ("admin-delete-user", |a| {
        scene(a, "/admin?section=users");
        crate::pages::admin::scenes::ready(a);
        crate::pages::admin::scenes::delete_user(a);
    }),
    ("admin-invites-past", |a| {
        scene(a, "/admin?section=invites");
        crate::pages::admin::scenes::ready(a);
        crate::pages::admin::scenes::invites_past(a);
    }),
    ("admin-invite-created", |a| {
        scene(a, "/admin?section=invites");
        crate::pages::admin::scenes::ready(a);
        crate::pages::admin::scenes::invite_created(a);
    }),
    ("admin-revoke-invite", |a| {
        scene(a, "/admin?section=invites");
        crate::pages::admin::scenes::ready(a);
        crate::pages::admin::scenes::revoke_invite(a);
    }),
    ("library-grid", |a| {
        scene(a, "/library");
        crate::pages::library::scenes::grid(a);
    }),
    ("library-select", |a| {
        scene(a, "/library");
        crate::pages::library::scenes::select(a);
    }),
    ("library-sort", |a| {
        scene(a, "/library");
        crate::pages::library::scenes::sort_open(a);
    }),
    ("library-search", |a| scene(a, "/library?q=harbour")),
    ("library-album", |a| scene(a, "/library?album=al-weather")),
    ("library-album-medium", |a| scene(a, "/library?album=al-lanterns")),
    ("library-artist", |a| scene(a, "/library?artist=ar-velvet")),
    ("library-tidal-album", |a| scene(a, "/library?tidalAlbum=381245566&tidalArtist=4419021")),
    ("library-tidal-saved", |a| scene(a, "/library?tidalAlbum=310077120")),
    ("library-tidal-artist", |a| scene(a, "/library?tidalArtist=4419021&artistName=Marisol%20Vey")),
    ("library-album-missing", |a| scene(a, "/library?album=missing")),
    ("library-tidal-missing", |a| scene(a, "/library?tidalAlbum=404404")),
    ("replay-last30", |a| scene(a, "/replay?period=last-30")),
    ("replay-month", |a| scene(a, "/replay?period=this-month")),
    ("replay-2025", |a| scene(a, "/replay?period=year:2025")),
    ("replay-all", |a| scene(a, "/replay?period=all")),
    ("replay-empty", |a| {
        scene(a, "/replay?period=last-30");
        crate::pages::replay::scenes::empty(a);
    }),
    ("replay-loading", |a| {
        scene(a, "/replay");
        crate::pages::replay::scenes::loading(a);
    }),
    ("replay-all-tracks", |a| {
        scene(a, "/replay");
        crate::pages::replay::scenes::all_tracks(a);
    }),
    ("drawer", |a| {
        scene(a, "/library");
        a.ui.mobile_nav_open = true;
    }),
    ("queue-open", crate::shell::player::scenes::queue_open),
    ("devices-open", crate::shell::player::scenes::devices_open),
    ("lyrics-open", crate::shell::player::scenes::lyrics_open),
    ("lyrics-narrow", crate::shell::player::scenes::lyrics_open),
    ("error-popover", crate::shell::player::scenes::error_popover),
    ("mini", crate::shell::player::scenes::mini_closed),
    ("mini-queue", crate::shell::player::scenes::mini_queue),
    ("mini-lyrics", crate::shell::player::scenes::mini_lyrics),
    ("mini-devices", crate::shell::player::scenes::mini_devices),
    ("mini-error", crate::shell::player::scenes::mini_error),
    ("player-playing", crate::shell::player::scenes::playing),
    ("login", crate::pages::auth::scenes::login),
    ("login-error", crate::pages::auth::scenes::login_error),
    ("register", crate::pages::auth::scenes::register),
    ("register-invite", crate::pages::auth::scenes::register_invite),
    ("reset-password", crate::pages::auth::scenes::reset_password),
    ("welcome", crate::pages::auth::scenes::welcome),
    ("welcome-server", crate::pages::auth::scenes::welcome_server),
    ("welcome-prefs", crate::pages::auth::scenes::welcome_prefs),
    ("welcome-change", crate::pages::auth::scenes::welcome_change),
    ("startup-loading", crate::pages::auth::scenes::startup_loading),
    ("startup-unreachable", crate::pages::auth::scenes::startup_unreachable),
    ("share-preview", crate::pages::auth::scenes::share),
    ("light", |a| {
        a.config.tweaks = Some(Tweaks { theme: Mode::Light, ..a.tweaks.clone() });
        a.tweaks.theme = Mode::Light;
    }),
];

/// [`SCENES`] and the overlays' scenes, for `--scene`.
fn all_scenes() -> &'static [(&'static str, fn(&mut App))] {
    static ALL: std::sync::OnceLock<Vec<(&'static str, fn(&mut App))>> = std::sync::OnceLock::new();
    ALL.get_or_init(|| SCENES.iter().chain(crate::overlays::scenes::SCENES).copied().collect())
}

pub fn spec() -> rune::AppSpec<App> {
    rune::AppSpec {
        min_size: Some((640.0, 480.0)),
        scenes: all_scenes(),
        fonts: crate::FONTS,
        families: ("Geist", "Geist Mono"),
        setup: Some(setup),
        poll: Some(poll),
        on_key: Some(on_key),
        ..rune::AppSpec::new("Lumen — Music Library", (1280.0, 820.0), init, view)
    }
}
