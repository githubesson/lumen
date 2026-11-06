//! `Sidebar.tsx`, `NavItem.tsx` and `SidebarPlaylists.tsx` (`sidebar.css`).

use rune::{Color, Cursor, El, Icon, col, el, row, text};

use crate::api::media;
use crate::app::App;
use crate::route::Location;
use crate::theme::{Layout, Theme, color_mix};
use crate::ui::{self, BtnState, brand_mark, font, ico, icons as i, iconbtn, line, with_lh};

/// Which Browse entry a /library URL belongs to (`libraryViewOf`).
fn library_view_of(loc: &Location) -> &'static str {
    if loc.has("album") || loc.has("tidalAlbum") {
        return "albums";
    }
    if loc.has("artist") || loc.has("tidalArtist") {
        return "artists";
    }
    match loc.get("view") {
        Some("tracks") => return "tracks",
        Some("albums") => return "albums",
        Some("artists") => return "artists",
        _ => {}
    }
    match loc.get("type") {
        Some("album") => "albums",
        Some("artist") => "artists",
        _ => "tracks",
    }
}

fn compact(t: &Theme) -> bool {
    t.layout == Layout::Compact
}

/// `.nav-section-title`: a 32 px label row with an 8 px top margin; in the
/// collapsed rail, a 16 px rule (or nothing beside the + button).
fn section_title(t: &Theme, label: &str, trailing: Option<El>) -> El {
    let ink = color_mix(t.c.sidebar_foreground, 0.70, Color::TRANSPARENT);
    let mut r = row().h(32.0).mt(8.0).items_center();
    if compact(t) {
        r = r.justify_center();
        match trailing {
            Some(tr) => r = r.child(tr),
            None => r = r.child(el().w(16.0).h(1.0).fill(t.c.sidebar_border)),
        }
        return r;
    }
    r = r.px(8.0).justify_between().child(text(label).font(font(12.0, 500.0)).color(ink));
    if let Some(tr) = trailing {
        r = r.child(tr);
    }
    r
}

/// `.nav-item`.
fn nav_item(t: &Theme, key: &str, glyph: &'static Icon, label: &str, active: bool, badge: Option<usize>, to: &str) -> El {
    let to = to.to_string();
    let mut item = row()
        .key(key)
        .h(32.0)
        .w_full()
        .items_center()
        .radius(t.radius_md())
        .role("link")
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover(t.c.sidebar_accent)
        .on_press(move |app: &mut App| app.navigate_to(&to))
        .child(ico(glyph, 16.0, t.c.sidebar_foreground));
    if active {
        item = item.fill(t.c.sidebar_accent);
    }
    if compact(t) {
        item = item.justify_center().help(label);
        if let Some(n) = badge {
            item = item.child(nav_badge(t, n, true));
        }
        return item;
    }
    item = item.px(8.0).gap(8.0).child(
        line(label, font(14.0, if active { 500.0 } else { 400.0 }), t.c.sidebar_foreground),
    );
    if let Some(n) = badge {
        item = item.child(el().grow(1.0)).child(nav_badge(t, n, false));
    }
    item
}

/// `.nav-badge`.
fn nav_badge(t: &Theme, n: usize, rail: bool) -> El {
    let (size, fs, pad) = if rail { (16.0, 10.0, 3.0) } else { (20.0, 12.0, 4.0) };
    let mut b = el()
        .h(size)
        .min_w(size)
        .px(pad)
        .radius(t.radius_md())
        .fill(t.c.primary)
        .center()
        .child(text(n.to_string()).font(ui::tnum(font(fs, 500.0))).color(t.c.primary_foreground));
    if rail {
        b = b.pin(None, Some(2.0), Some(2.0), None);
    }
    b
}

pub fn view(app: &App, t: &Theme, drawer: bool) -> El {
    // The drawer always shows the full sidebar, whatever the layout tweak.
    let full = Theme { layout: if drawer && t.layout == Layout::Compact { Layout::Sidebar } else { t.layout }, ..*t };
    let t = &full;
    let loc = app.location();
    let library_view = loc.is("/library").then(|| library_view_of(loc));
    let w = t.layout.sidebar_w();

    let brand = {
        let mut b = row()
            .key("brand")
            .h(48.0)
            .px(8.0)
            .items_center()
            .role("link")
            .cursor(Cursor::Pointer)
            .on_press(|app: &mut App| app.navigate_to("/"))
            .child(brand_mark(t, 32.0));
        if compact(t) {
            b = b.justify_center();
        } else {
            b = b.gap(8.0).child(text("Lumen").font(with_lh(font(14.0, 600.0), 16.8)).color(t.c.sidebar_foreground));
        }
        b
    };

    let nav_pad = 8.0;
    let mut nav = col().key("nav").padding(nav_pad);
    nav = nav.child(section_title(t, "Browse", None));
    nav = nav.child(nav_item(t, "nav-home", &i::HOUSE, "Home", loc.is("/"), None, "/"));
    for (label, to, glyph, view) in [
        ("Tracks", "/library", &i::MUSIC, "tracks"),
        ("Albums", "/library?view=albums", &i::DISC_3, "albums"),
        ("Artists", "/library?view=artists", &i::USER_ROUND, "artists"),
    ] {
        nav = nav.child(nav_item(t, &format!("nav-{view}"), glyph, label, library_view == Some(view), None, to));
    }
    nav = nav.child(section_title(t, "Library", None));
    for (label, to, glyph) in [
        ("Favorites", "/favorites", &i::HEART),
        ("Recent", "/recent", &i::CLOCK),
        ("Replay", "/replay", &i::SPARKLES),
    ] {
        nav = nav.child(nav_item(t, &format!("nav{to}").replace('/', "-"), glyph, label, loc.starts_with(to), None, to));
    }
    if app.pending_invites > 0 {
        nav = nav.child(nav_item(
            t,
            "nav-invites",
            &i::MAIL,
            "Invites",
            loc.starts_with("/invites"),
            Some(app.pending_invites),
            "/invites",
        ));
    }

    let mut c = col()
        .key("sidebar")
        .h_full()
        .min_h(0.0)
        .child(brand)
        .child(nav)
        .child(playlists(app, t));
    if drawer {
        c = c.w_full().child(mobile_actions(app, t));
    } else {
        c = c.w(w);
    }
    c.child(footer(app, t))
}

/// `MobileSidebarActions`: the top bar's secondary buttons, in the drawer.
fn mobile_actions(app: &App, t: &Theme) -> El {
    let dark = t.dark();
    let action = |key: &str, glyph: &'static Icon, label: &str| {
        row()
            .key(key)
            .min_h(48.0)
            .w_full()
            .px(8.0)
            .gap(8.0)
            .items_center()
            .radius(t.radius_md())
            .role("button")
            .cursor(Cursor::Pointer)
            .focusable(true)
            .hover(t.c.sidebar_accent)
            .child(ico(glyph, 16.0, t.c.sidebar_foreground))
            .child(line(label, font(14.0, 400.0), t.c.sidebar_foreground))
    };
    let _ = app;
    ui::css_border(col(), 0.0, Color::TRANSPARENT, 0.0)
        .child(el().pin(Some(0.0), Some(0.0), Some(0.0), None).h(1.0).fill(t.c.border).inert())
        .padding(8.0)
        .pt(9.0)
        .gap(2.0)
        .child(action("mobile-add-music", &i::UPLOAD, "Add music").on_press(|app: &mut App| {
            app.ui.mobile_nav_open = false;
            app.ui.upload_open = true;
        }))
        .child(
            action("mobile-theme", if dark { &i::SUN } else { &i::MOON }, if dark { "Light mode" } else { "Dark mode" })
                .on_press(|app: &mut App| app.toggle_theme()),
        )
        .child(action("mobile-settings", &i::SLIDERS_HORIZONTAL, "Settings").on_press(|app: &mut App| {
            app.ui.mobile_nav_open = false;
            app.ui.settings_open = true;
        }))
}

/// The narrow window's sidebar: a floating drawer over a scrim, sliding in
/// from the left (`responsive.css` at 760 px and under).
pub fn drawer(app: &App, t: &Theme, window_w: f32) -> Option<El> {
    if !app.ui.mobile_nav_open {
        return None;
    }
    let w = 296.0f32.min(window_w - 48.0);
    let a = t.c.shadow_md_alpha;
    let panel = ui::css_border(col(), 1.0, t.c.sidebar_border, t.radius_xl())
        .key("sidebar-drawer")
        .pin(Some(4.0), Some(4.0), None, Some(4.0))
        .w(w)
        .padding(1.0)
        .radius(t.radius_xl())
        .fill(t.c.sidebar)
        .clip_rounded(t.radius_xl())
        .box_shadow(rune::Shadow { x: 0.0, y: 4.0, blur: 6.0, spread: -1.0, color: Color::BLACK.alpha(a), inset: false })
        .box_shadow(rune::Shadow { x: 0.0, y: 2.0, blur: 4.0, spread: -2.0, color: Color::BLACK.alpha(a), inset: false })
        .transition(rune::Transition::offset(-(w + 12.0), 0.0))
        .child(view(app, t, true));
    Some(el().key("mobile-nav")
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .modal(true, |app: &mut App| app.ui.mobile_nav_open = false)
        .child(
            el().key("mobile-nav-backdrop")
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .fill(t.c.scrim)
                .label("Close navigation")
                .transition(rune::Transition::opacity())
                .on_press(|app: &mut App| app.ui.mobile_nav_open = false),
        )
        .child(panel))
}

/// `SidebarPlaylists`: scrolls without a scrollbar.
fn playlists(app: &App, t: &Theme) -> El {
    let loc = app.location();
    let add = el()
        .key("new-playlist")
        .size(22.0, 22.0)
        .radius(t.radius_lg())
        .center()
        .role("link")
        .cursor(Cursor::Pointer)
        .hover(t.c.ghost_hover)
        .help("New playlist")
        .on_press(|app: &mut App| app.navigate_to("/playlists/new"))
        .child(ico(&i::PLUS, 12.0, t.c.foreground));
    let mut list = col().key("sidebar-playlists").px(8.0).pb(12.0);
    list = list.child(section_title(t, "Playlists", Some(add)));
    list = list.child(nav_item(t, "nav-playlists", &i::LIST_MUSIC, "All playlists", loc.is("/playlists"), None, "/playlists"));
    if let Some(pls) = &app.playlists {
        if pls.is_empty() && !compact(t) {
            list = list.child(
                el().px(10.0)
                    .py(4.0)
                    .child(text("None yet").font(ui::mono(12.0, 400.0)).color(t.c.muted_foreground)),
            );
        }
        for p in pls {
            let active = loc.path == format!("/playlists/{}", p.id);
            let to = format!("/playlists/{}", p.id);
            let art = ui::cover_art_letter_size(
                t,
                &app.images,
                media::playlist_art(p, Some(64)).as_deref(),
                &p.name,
                20.0,
                4.0,
                11.0,
            );
            let mut r = row()
                .key(format!("sidebar-playlist-{}", p.id))
                .h(32.0)
                .items_center()
                .radius(t.radius_md())
                .role("link")
                .cursor(Cursor::Pointer)
                .focusable(true)
                .hover(t.c.sidebar_accent)
                .on_press(move |app: &mut App| app.navigate_to(&to))
                // `margin: 0 -2px` lets the 20 px cover sit in the 16 px icon column.
                .child(el().mx(-2.0).child(art));
            if active {
                r = r.fill(t.c.sidebar_accent);
            }
            if compact(t) {
                r = r.justify_center().help(p.name.clone());
            } else {
                r = r.px(8.0).gap(8.0).child(
                    line(p.name.clone(), font(14.0, if active { 500.0 } else { 400.0 }), t.c.sidebar_foreground).grow(1.0),
                );
            }
            list = list.child(r);
        }
    }
    col()
        .key("sidebar-playlists-scroller")
        .grow(1.0)
        .min_h(0.0)
        .child(col().grow(1.0).min_h(0.0).scroll(rune::ScrollSpec { stick_bottom: false }).scroll_edge_fade(32.0).child(list))
}

/// `SidebarFooter`.
fn footer(app: &App, t: &Theme) -> El {
    let me = app.me();
    let name = me.map(|m| m.username.clone()).unwrap_or_default();
    let initial: String = name.chars().take(2).collect::<String>().to_uppercase();
    let initial = if initial.is_empty() { "?".to_string() } else { initial };
    let admin = me.is_some_and(|m| m.is_admin());
    let avatar = el()
        .size(32.0, 32.0)
        .radius(t.radius_lg())
        .fill(t.c.muted)
        .center()
        .child(text(initial).font(font(12.0, 500.0)).color(t.c.foreground));

    let admin_btn = admin.then(|| {
        iconbtn(t, "footer-admin", &i::SETTINGS, 16.0, BtnState { active: app.location().starts_with("/admin"), disabled: false })
            .help("Admin")
            .label("Admin")
            .on_press(|app: &mut App| app.navigate_to("/admin"))
    });
    let sign_out = iconbtn(t, "footer-sign-out", &i::LOG_OUT, 16.0, BtnState::default())
        .help("Sign out")
        .label("Sign out")
        .on_press(|app: &mut App| app.sign_out());

    if compact(t) {
        let mut c = col().key("sidebar-footer").padding(8.0).gap(4.0).items_center().child(avatar);
        if let Some(b) = admin_btn {
            c = c.child(b);
        }
        return c.child(sign_out);
    }
    let user = col()
        .grow(1.0)
        .min_w(0.0)
        .child(line(name, with_lh(font(14.0, 500.0), 17.5), t.c.foreground))
        .child(line(if admin { "admin" } else { "local library" }, font(12.0, 400.0), t.c.muted_foreground));
    let mut r = row().key("sidebar-footer").padding(8.0).gap(8.0).items_center().child(avatar).child(user);
    if let Some(b) = admin_btn {
        r = r.child(b);
    }
    r.child(sign_out)
}
