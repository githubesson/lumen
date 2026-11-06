//! The app's state and root view: `App.tsx`, the providers in `main.tsx`,
//! and the desktop bridge's state that lived in Electron's main process.

use rune::{Color, Cx, El, KeyEvent, Tx, Waker, col, el};

use crate::api::{self, Client, Me, Playlist};
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
    /// The sidebar drawer of narrow windows (`useMobileNav`).
    pub mobile_nav_open: bool,
}

pub struct App {
    pub config: Config,
    pub tweaks: Tweaks,
    /// The OS appearance, used until the user picks a theme.
    pub system_dark: std::cell::Cell<bool>,
    pub waker: LateWaker,
    pub net: Net,
    pub images: Images,
    pub client: Option<Client>,
    pub session: Session,
    pub history: History,
    /// `usePlaylists().data`: None until loaded.
    pub playlists: Option<Vec<Playlist>>,
    pub pending_invites: usize,
    pub ui: Ui,
    pub player: crate::player::Player,
    pub pages: crate::pages::Pages,
    pub overlays: crate::overlays::Overlays,
    /// The open `<Select>` listbox, if any.
    pub select: Option<crate::ui::forms::OpenSelect>,
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
            images,
            net,
            client: None,
            session: Session::Loading,
            history: History::new(Location::parse("/")),
            playlists: None,
            pending_invites: 0,
            ui: Ui::default(),
            player: crate::player::Player::default(),
            pages: crate::pages::Pages::default(),
            overlays: crate::overlays::Overlays::default(),
            select: None,
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
        self.images.set_client(Some(client.clone()));
        self.client = Some(client);
        self.session = Session::Loading;
        self.refresh_me();
    }

    pub fn refresh_me(&mut self) {
        let Some(client) = self.client.clone() else { return };
        self.net.run(
            move || client.get::<Me>("/api/auth/me"),
            |app, result| match result {
                Ok(me) => app.signed_in(me),
                Err(e) if e.is_unauthorized() => {
                    app.session = Session::SignedOut;
                    app.navigate_replace(Location::parse("/login"));
                }
                Err(e) => app.session = Session::Unreachable(e.to_string()),
            },
        );
    }

    fn signed_in(&mut self, me: Me) {
        self.session = Session::SignedIn(me);
        if self.location().is("/login") {
            self.navigate_replace(Location::parse("/"));
        }
        self.load_playlists();
        self.load_pending_invites();
        let loc = self.location().clone();
        crate::pages::enter(self, &loc);
    }

    pub fn me(&self) -> Option<&Me> {
        match &self.session {
            Session::SignedIn(me) => Some(me),
            _ => None,
        }
    }

    pub fn load_playlists(&mut self) {
        let Some(client) = self.client.clone() else { return };
        self.net.run(
            move || client.get::<Option<Vec<Playlist>>>("/api/playlists"),
            |app, result| {
                if let Ok(list) = result {
                    app.playlists = Some(list.unwrap_or_default());
                }
            },
        );
    }

    fn load_pending_invites(&mut self) {
        let Some(client) = self.client.clone() else { return };
        self.net.run(
            move || client.get::<Option<Vec<api::PendingInvite>>>("/api/playlists/invites"),
            |app, result| {
                if let Ok(list) = result {
                    app.pending_invites = list.map_or(0, |l| l.len());
                }
            },
        );
    }

    pub fn location(&self) -> &Location {
        self.history.current()
    }

    /// Follow a link (`navigate(to)`).
    pub fn navigate(&mut self, loc: Location) {
        self.history.push(loc.clone());
        crate::pages::enter(self, &loc);
    }

    pub fn navigate_to(&mut self, href: &str) {
        self.navigate(Location::parse(href));
    }

    /// `navigate(to, { replace: true })`.
    pub fn navigate_replace(&mut self, loc: Location) {
        self.history.replace(loc.clone());
        crate::pages::enter(self, &loc);
    }

    pub fn back(&mut self) {
        if self.history.back() {
            let loc = self.location().clone();
            crate::pages::enter(self, &loc);
        }
    }

    pub fn forward(&mut self) {
        if self.history.forward() {
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

    pub fn sign_out(&mut self) {
        let Some(client) = self.client.clone() else { return };
        self.player.stop();
        self.net.run(
            move || {
                let _ = client.post_void("/api/auth/logout", None);
                client.clear_cookies();
            },
            |app, ()| {
                app.session = Session::SignedOut;
                app.playlists = None;
                app.pending_invites = 0;
                app.pages = Default::default();
                app.history = History::new(Location::parse("/login"));
            },
        );
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

fn poll(app: &mut App, _clock: f64, tx: &mut Tx) -> bool {
    let mut changed = Net::drain(app);
    changed |= app.player.poll(tx);
    changed
}

fn on_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    crate::keys::on_key(app, ev, tx)
}

pub fn view(app: &App, cx: &mut Cx<App>) -> El {
    app.system_dark.set(cx.system_dark());
    let t = app.theme();
    let body = match &app.session {
        Session::SignedIn(_) => crate::shell::view(app, &t, cx),
        Session::Loading => el().w_full().h_full(),
        Session::SignedOut | Session::Unreachable(_) => crate::pages::signed_out(app, &t, cx),
    };
    let mut root = col().key("root").w_full().h_full().fill(Color::TRANSPARENT).child(body);
    if matches!(app.session, Session::SignedIn(_)) {
        for layer in crate::overlays::view(app, &t, cx) {
            root = root.child(layer);
        }
    }
    root
}

/// Scenes for headless snapshots: each signs in against `LUMEN_SERVER` (the
/// mock server by default) and opens one screen with its data loaded.
fn scene(app: &mut App, path: &str) {
    if app.client.is_none() {
        app.connect(&std::env::var("LUMEN_SERVER").unwrap_or_else(|_| "http://127.0.0.1:4791".into()));
    }
    app.settle_sync();
    app.navigate(Location::parse(path));
    crate::player::scene_loaded_track(app);
    app.settle_sync();
}

pub const SCENES: &[(&str, fn(&mut App))] = &[
    ("home", |a| scene(a, "/")),
    ("library", |a| scene(a, "/library")),
    ("albums", |a| scene(a, "/library?view=albums")),
    ("artists", |a| scene(a, "/library?view=artists")),
    ("favorites", |a| scene(a, "/favorites")),
    ("recent", |a| scene(a, "/recent")),
    ("playlists", |a| scene(a, "/playlists")),
    ("replay", |a| scene(a, "/replay")),
    ("admin", |a| scene(a, "/admin")),
    ("drawer", |a| {
        scene(a, "/library");
        a.ui.mobile_nav_open = true;
    }),
    ("light", |a| {
        a.config.tweaks = Some(Tweaks { theme: Mode::Light, ..a.tweaks.clone() });
        a.tweaks.theme = Mode::Light;
    }),
];

pub fn spec() -> rune::AppSpec<App> {
    rune::AppSpec {
        min_size: Some((640.0, 480.0)),
        scenes: SCENES,
        fonts: crate::FONTS,
        families: ("Geist", "Geist Mono"),
        setup: Some(setup),
        poll: Some(poll),
        on_key: Some(on_key),
        ..rune::AppSpec::new("Lumen — Music Library", (1280.0, 820.0), init, view)
    }
}
