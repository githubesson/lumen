//! `Topbar.tsx`, `Breadcrumbs.tsx` and `WindowControls.tsx`
//! (`main-content.css`, `electron.css`).

use rune::{Color, Cursor, El, el, row};

use crate::app::App;
use crate::route::Location;
use crate::theme::{Layout, Theme};
use crate::ui::{self, BtnState, css_border, font, ico, icons as i, iconbtn, kbd};
use crate::ui::tooltip::TipExt;

struct Crumb {
    label: String,
    to: Option<String>,
    replace: bool,
    current: bool,
}

fn crumb(label: &str, to: Option<&str>, current: bool) -> Crumb {
    Crumb { label: label.into(), to: to.map(str::to_string), replace: false, current }
}

/// `buildCrumbs`.
fn crumbs(app: &App, loc: &Location) -> Vec<Crumb> {
    let p = loc.path.as_str();
    if p == "/" {
        return vec![crumb("Home", None, true)];
    }
    if p.starts_with("/library") {
        if crate::pages::library_drill::has_drill(loc) {
            let rest = crate::pages::library_drill::without_drill(loc);
            let to = if rest.query.is_empty() { "/library".to_string() } else { rest.href() };
            return vec![Crumb { label: "Library".into(), to: Some(to), replace: true, current: false }];
        }
        return vec![crumb("Library", None, true)];
    }
    for (prefix, label) in [("/favorites", "Favorites"), ("/recent", "Recent"), ("/replay", "Replay")] {
        if p.starts_with(prefix) {
            return vec![crumb("Library", Some("/library"), false), crumb(label, None, true)];
        }
    }
    if p == "/playlists" {
        return vec![crumb("Playlists", None, true)];
    }
    if p == "/playlists/new" {
        return vec![crumb("Playlists", Some("/playlists"), false), crumb("New", None, true)];
    }
    if p.starts_with("/playlists/")
        && let Some(id) = loc.segment(1)
    {
        let name = app
            .playlists
            .data
            .as_ref()
            .and_then(|ps| ps.iter().find(|x| x.id == id))
            .map(|x| x.name.clone())
            .unwrap_or_else(|| "…".into());
        return vec![crumb("Playlists", Some("/playlists"), false), crumb(&name, None, true)];
    }
    if p.starts_with("/invites") {
        return vec![crumb("Invites", None, true)];
    }
    if p.starts_with("/admin") {
        return vec![crumb("Admin", None, true)];
    }
    if p.starts_with("/reset-password") {
        return vec![crumb("Reset password", None, true)];
    }
    vec![crumb("Home", None, true)]
}

fn breadcrumbs(app: &App, t: &Theme) -> El {
    let mut nav = row().key("crumbs").gap(6.0).items_center().shrink();
    for (n, c) in crumbs(app, app.location()).into_iter().enumerate() {
        let mut part = row().gap(6.0).items_center().shrink();
        if n > 0 {
            part = part.child(ico(&i::CHEVRON_RIGHT, 12.0, t.c.muted_foreground));
        }
        let style = font(14.0, 400.0);
        let label = if c.current {
            ui::line(c.label, style, t.c.foreground)
        } else if let Some(to) = c.to {
            let replace = c.replace;
            ui::line(c.label, style, t.c.muted_foreground)
                .hover(t.c.ghost_hover)
                .focusable(true)
                .role("link")
                .cursor(Cursor::Pointer)
                .on_press(move |app: &mut App| {
                    if replace {
                        app.navigate_replace(Location::parse(&to));
                    } else {
                        app.navigate_to(&to);
                    }
                })
        } else {
            ui::line(c.label, style, t.c.muted_foreground)
        };
        part = part.child(label);
        nav = nav.child(part);
    }
    nav
}

/// `.search.topbar-search`: opens the command palette.
fn search(t: &Theme, window_w: f32) -> El {
    let w = 320.0f32.min(window_w * 0.4);
    let b = css_border(el(), 1.0, t.c.input, t.radius_lg());
    // `flex: 0 1 auto; min-width: 0`: it gives up width before the bar
    // overflows (a 900 px window with the sidebar).
    b.key("topbar-search")
        .w(w)
        .shrink()
        .h(32.0)
        .pl(11.0)
        .pr(7.0)
        .gap(8.0)
        .items_center()
        .radius(t.radius_lg())
        .fill(t.c.input_bg)
        .hover(ui::hover_overlay(t.c.input_bg, t.c.input_bg_hover))
        .role("button")
        .label("Search library, albums, tracks… Ctrl+K")
        .cursor(Cursor::Pointer)
        .focusable(true)
        .on_press(crate::overlays::palette::open)
        .child(ico(&i::SEARCH, 14.0, t.c.muted_foreground))
        .child(ui::line("Search library, albums, tracks…", font(14.0, 400.0), t.c.muted_foreground).grow(1.0))
        .child(kbd(t, "Ctrl+K"))
}

/// The narrow window's search: a 32 px icon button (`.topbar-search` without
/// its label and key cap).
fn search_icon(t: &Theme) -> El {
    css_border(el(), 1.0, t.c.input, t.radius_lg())
        .key("topbar-search")
        .size(32.0, 32.0)
        .center()
        .radius(t.radius_lg())
        .fill(t.c.input_bg)
        .hover(ui::hover_overlay(t.c.input_bg, t.c.input_bg_hover))
        .role("button")
        .label("Search library, albums, tracks… Ctrl+K")
        .cursor(Cursor::Pointer)
        .focusable(true)
        .on_press(crate::overlays::palette::open)
        .child(ico(&i::SEARCH, 14.0, t.c.muted_foreground))
}

/// `WindowControls`: minimize, maximize and close in a bordered group.
pub fn window_controls(t: &Theme) -> El {
    let button = |key: &str, glyph: &'static rune::Icon, size: f32, close: bool| {
        let hover_fill = if close { t.c.destructive } else { t.c.muted };
        let hover_ink = if close { Color::WHITE } else { t.c.foreground };
        el().key(key)
            .size(34.0, 28.0)
            .radius(t.radius_md())
            .center()
            .role("button")
            .cursor(Cursor::Pointer)
            .hover(hover_fill)
            .hover_motion(crate::ui::motion::ease(120.0), crate::ui::motion::ease(120.0))
            .child(ico(glyph, size, t.c.muted_foreground).group_color(hover_ink))
    };
    css_border(row(), 1.0, t.c.border, t.radius_lg())
        .key("window-controls")
        .h(32.0)
        .padding(3.0)
        .gap(2.0)
        .items_center()
        .radius(t.radius_lg())
        .fill(t.c.background)
        .child(
            button("window-minimize", &i::MINUS, 16.0, false)
                .label("Minimize")
                .tip("window-minimize", "Minimize")
                .on_press_tx(|_: &mut App, tx| crate::desktop::window::minimize(tx)),
        )
        .child(
            button("window-maximize", &i::COPY, 14.0, false)
                .label("Maximize")
                .tip("window-maximize", "Maximize")
                .on_press_tx(|_: &mut App, tx| {
                    crate::desktop::window::toggle_maximize(tx);
                }),
        )
        .child(
            button("window-close", &i::X, 16.0, true)
                .label("Close")
                .tip("window-close", "Close")
                .on_press_tx(|_: &mut App, tx| crate::desktop::window::close(tx)),
        )
}

pub fn view(app: &App, t: &Theme, window_w: f32, bp: super::Bp) -> El {
    let narrow = bp == super::Bp::Narrow;
    let compact = t.layout == Layout::Compact;
    let on_home = app.location().is("/");
    let customizing = on_home && app.location().has("customize");
    let dark = t.dark();

    let mut bar = ui::css_border_bottom(row(), 1.0, t.c.border)
        .key("topbar")
        .h(48.0)
        .px(if narrow { 8.0 } else { t.pad() })
        .pb(1.0)
        .gap(8.0)
        .items_center()
        .window_drag();
    if narrow {
        let open = app.ui.mobile_nav_open;
        let label = if open { "Close navigation" } else { "Open navigation" };
        bar = bar
            .child(
                iconbtn(t, "sidebar-toggle-mobile", if open { &i::X } else { &i::MENU }, 16.0, BtnState::default())
                    .label(label)
                    .tip("sidebar-toggle-mobile", label)
                    .expanded(open)
                    .on_press(|app: &mut App| app.ui.mobile_nav_open = !app.ui.mobile_nav_open),
            )
            .child(breadcrumbs(app, t).grow(1.0))
            .child(search_icon(t));
    } else {
        bar = bar
            .child(
                iconbtn(t, "sidebar-toggle", if compact { &i::PANEL_LEFT_OPEN } else { &i::PANEL_LEFT_CLOSE }, 16.0, BtnState::default())
                    .label(if compact { "Expand sidebar" } else { "Collapse sidebar" })
                    .tip("sidebar-toggle", if compact { "Expand sidebar" } else { "Collapse sidebar" })
                    .on_press_tx(|app: &mut App, tx| {
                        // `.app`'s `grid-template-columns` transition.
                        tx.motion_curve(crate::ui::motion::shell(280.0));
                        app.toggle_sidebar();
                    }),
            )
            .child(breadcrumbs(app, t))
            .child(el().grow(1.0).h(1.0))
            .child(search(t, window_w));
    }
    if on_home {
        bar = bar.child(
            iconbtn(t, "customize-home", &i::LAYOUT_DASHBOARD, 16.0, BtnState { active: customizing, disabled: false })
                .label("Customize Home")
                .tip("customize-home", if customizing { "Done customizing" } else { "Customize Home" })
                .on_press(move |app: &mut App| {
                    let to = if customizing { "/" } else { "/?customize" };
                    app.navigate_replace(Location::parse(to));
                }),
        );
    }
    bar = bar.child(
        iconbtn(t, "toggle-lyrics", &i::MIC_VOCAL, 16.0, BtnState { active: app.ui.lyrics_open, disabled: false })
            .label("Toggle lyrics panel")
            .tip("toggle-lyrics", "Lyrics")
            .on_press(|app: &mut App| app.ui.lyrics_open = !app.ui.lyrics_open),
    );
    if narrow {
        // `.topbar-secondary` hides on narrow windows.
        return bar.child(window_controls(t));
    }
    bar.child(
        iconbtn(t, "add-music", &i::UPLOAD, 16.0, BtnState::default())
            .label("Add music")
            .tip("add-music", "Add music")
            .on_press(crate::overlays::upload::open),
    )
    .child(
        iconbtn(t, "toggle-theme", if dark { &i::SUN } else { &i::MOON }, 16.0, BtnState::default())
            .label("Toggle theme")
            .tip("toggle-theme", if dark { "Switch to light mode" } else { "Switch to dark mode" })
            .on_press(|app: &mut App| app.toggle_theme()),
    )
    .child(
        iconbtn(t, "open-settings", &i::SLIDERS_HORIZONTAL, 16.0, BtnState { active: app.ui.settings_open, disabled: false })
            .label("Settings")
            .tip("open-settings", "Settings")
            .on_press(crate::overlays::settings::toggle),
    )
    .child(window_controls(t))
}
