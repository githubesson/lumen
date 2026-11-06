//! `panelKinds.ts`: every kind of panel Home can show, with what the Add
//! panel dialog says about it and how big a new one starts out.
//!
//! Widths are sixths of the wide board (a third, a half, two thirds or all
//! of it) and heights are board rows. A kind whose panel can say different
//! things (a period's top tracks, one playlist) can go on the board more than
//! once; the rest only once.

use super::logic::Period;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PanelKind {
    Resume,
    Repeat,
    Artists,
    TopAlbums,
    Stats,
    Genres,
    Activity,
    Recent,
    Favorites,
    Added,
    Albums,
    Playlists,
    Playlist,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanelGroup {
    Listening,
    Library,
}

/// `PanelKindInfo`.
pub struct PanelKindInfo {
    /// Its title on the board, unless renamed.
    pub title: &'static str,
    /// What the Add panel dialog says it shows.
    pub description: &'static str,
    pub group: PanelGroup,
    pub w: u8,
    pub h: u8,
    /// It shows a Replay period's numbers, which the user picks.
    pub period: bool,
    /// It shows one playlist, which the user picks.
    pub playlist: bool,
}

const fn info(title: &'static str, description: &'static str, group: PanelGroup, w: u8, h: u8) -> PanelKindInfo {
    PanelKindInfo { title, description, group, w, h, period: false, playlist: false }
}

const fn period(i: PanelKindInfo) -> PanelKindInfo {
    PanelKindInfo { period: true, ..i }
}

use PanelGroup::{Library, Listening};

static RESUME: PanelKindInfo =
    info("Jump back in", "The album you were last on, with Play to pick up where you left off.", Library, 4, 1);
static REPEAT: PanelKindInfo =
    period(info("On repeat", "Your most played tracks, ranked, for the period you pick.", Listening, 2, 2));
static ARTISTS: PanelKindInfo = period(info("Top artists", "The artists you've played most in a period.", Listening, 6, 1));
static TOP_ALBUMS: PanelKindInfo = period(info("Top albums", "The albums you've played most in a period.", Listening, 6, 1));
static STATS: PanelKindInfo =
    period(info("Your listening", "Plays, listening time, tracks and artists in a period.", Listening, 2, 1));
static GENRES: PanelKindInfo =
    period(info("Top genres", "The genres you've played most in a period, by share of plays.", Listening, 2, 1));
static ACTIVITY: PanelKindInfo =
    period(info("Listening activity", "How much you played across a period, as a chart.", Listening, 4, 1));
static RECENT: PanelKindInfo = info("Recently played", "The last tracks you played.", Library, 2, 1);
static FAVORITES: PanelKindInfo = info("Your favorites", "Tracks you've hearted, newest first.", Library, 2, 1);
static ADDED: PanelKindInfo = info("Recently added", "The newest tracks in your library.", Library, 2, 1);
static ALBUMS: PanelKindInfo = info("Albums", "The albums newest to your library.", Library, 4, 1);
static PLAYLISTS: PanelKindInfo = info("Playlists", "Your playlists, to open or play.", Library, 2, 1);
static PLAYLIST: PanelKindInfo = PanelKindInfo {
    playlist: true,
    ..info("Playlist", "One playlist's tracks, to play from any of them.", Library, 2, 1)
};

impl PanelKind {
    /// `PANEL_KIND_IDS`: in `PANEL_KINDS`' key order, which the Add panel
    /// dialog lists them in.
    pub const ALL: [PanelKind; 13] = [
        PanelKind::Resume,
        PanelKind::Repeat,
        PanelKind::Artists,
        PanelKind::TopAlbums,
        PanelKind::Stats,
        PanelKind::Genres,
        PanelKind::Activity,
        PanelKind::Recent,
        PanelKind::Favorites,
        PanelKind::Added,
        PanelKind::Albums,
        PanelKind::Playlists,
        PanelKind::Playlist,
    ];

    pub fn id(self) -> &'static str {
        match self {
            PanelKind::Resume => "resume",
            PanelKind::Repeat => "repeat",
            PanelKind::Artists => "artists",
            PanelKind::TopAlbums => "top-albums",
            PanelKind::Stats => "stats",
            PanelKind::Genres => "genres",
            PanelKind::Activity => "activity",
            PanelKind::Recent => "recent",
            PanelKind::Favorites => "favorites",
            PanelKind::Added => "added",
            PanelKind::Albums => "albums",
            PanelKind::Playlists => "playlists",
            PanelKind::Playlist => "playlist",
        }
    }

    pub fn parse(s: &str) -> Option<PanelKind> {
        PanelKind::ALL.into_iter().find(|k| k.id() == s)
    }

    pub fn info(self) -> &'static PanelKindInfo {
        match self {
            PanelKind::Resume => &RESUME,
            PanelKind::Repeat => &REPEAT,
            PanelKind::Artists => &ARTISTS,
            PanelKind::TopAlbums => &TOP_ALBUMS,
            PanelKind::Stats => &STATS,
            PanelKind::Genres => &GENRES,
            PanelKind::Activity => &ACTIVITY,
            PanelKind::Recent => &RECENT,
            PanelKind::Favorites => &FAVORITES,
            PanelKind::Added => &ADDED,
            PanelKind::Albums => &ALBUMS,
            PanelKind::Playlists => &PLAYLISTS,
            PanelKind::Playlist => &PLAYLIST,
        }
    }

    /// `allowsMany`: kinds that can be on the board more than once.
    pub fn allows_many(self) -> bool {
        let i = self.info();
        i.period || i.playlist
    }
}

/// `PANEL_WIDTHS`.
pub const PANEL_WIDTHS: [u8; 4] = [2, 3, 4, 6];
/// `PANEL_HEIGHTS`.
pub const PANEL_HEIGHTS: [u8; 2] = [1, 2];

/// `PANEL_WIDTH_LABELS`.
pub fn width_label(w: u8) -> &'static str {
    match w {
        2 => "Third",
        3 => "Half",
        4 => "Two thirds",
        _ => "Full",
    }
}

/// `PANEL_HEIGHT_LABELS`.
pub fn height_label(h: u8) -> &'static str {
    if h == 2 { "Tall" } else { "Regular" }
}

/// The period a new panel shows, and the built-in ones always did.
pub const DEFAULT_PERIOD: Period = Period::Last30;

/// `periodSub`: the eyebrow a period panel shows over its title.
pub fn period_sub(period: Option<Period>) -> String {
    period.unwrap_or(DEFAULT_PERIOD).label()
}
