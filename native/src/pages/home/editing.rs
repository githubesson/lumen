//! `BoardEditing.tsx` (`board.css`'s Customizing): while editing, every
//! panel turns into a tile to drag onto another (they swap places), to edit
//! (its size, name and what it shows) or to hide, and a bar above the board
//! lists hidden panels, Add panel, Reset and Done. Move, then Swap here on
//! another panel, does the same as a drag, from the keyboard.

use rune::{Color, Cursor, El, Key, KeyEvent, Phase, Tx, col, el, row, text};

use crate::app::App;
use crate::route::Location;
use crate::theme::Theme;
use crate::ui::{Btn, font, ico, icons as i, line, with_lh};

use super::arrangement::{
    DEFAULT_PANEL_IDS, HomeArrangement, HomePanel, add_panel, default_arrangement, find_panel, is_default_arrangement,
    panel_title, remove_panel, set_panel_hidden, swap_panels,
};
use super::kinds::{PanelKind, period_sub};
use super::logic::Period;
use super::Model;
use super::board::lh;

/// The open dialog: Add panel, a panel's settings (and the panel next to
/// it, for focus if it's removed), or Reset's confirmation.
#[derive(Clone, Debug, PartialEq)]
pub enum Dialog {
    Add,
    Settings { id: String, next: Option<String> },
    Reset,
}

/// Customizing's state (`useBoardEditor`).
#[derive(Default)]
pub struct Edit {
    /// Picked with Move, waiting for Swap here.
    pub moving: Option<String>,
    /// Being dragged, and the panel the drag is over.
    pub dragging: Option<String>,
    pub target: Option<String>,
    /// How far the drag has carried the pointer, for the drag image.
    pub drag_offset: [f32; 2],
    /// What the last change did, for screen readers.
    pub announcement: String,
    pub dialog: Option<Dialog>,
    /// The dialogs' own state.
    pub dialogs: super::dialogs::DialogState,
}

/// Leaving customizing drops what it had going.
pub fn reset(app: &mut App) {
    let e = &mut app.pages.home.edit;
    e.moving = None;
    e.dragging = None;
    e.target = None;
    e.announcement.clear();
    e.dialog = None;
}

pub fn arrangement(app: &App) -> HomeArrangement {
    super::arrangement::read_arrangement(app.tweaks.home_board.as_ref())
}

/// Saves the arrangement (`setHomeBoard(arrangementTweak(next))`).
pub fn save(app: &mut App, next: &HomeArrangement) {
    let tweak = super::arrangement::arrangement_tweak(next);
    app.set_tweaks(|t| t.home_board = tweak);
}

fn title_of(app: &App, p: &HomePanel) -> String {
    panel_title(p, app.playlists.as_deref())
}

/// A panel's name for screen readers and announcements: with its period,
/// so two On repeats tell apart.
pub fn label_of(app: &App, p: &HomePanel) -> String {
    if p.kind.info().period { format!("{} ({})", title_of(app, p), period_sub(p.period)) } else { title_of(app, p) }
}

fn label_by_id(app: &App, id: &str) -> String {
    find_panel(&arrangement(app), id).map(|p| label_of(app, p)).unwrap_or_default()
}

/// Applies a change and says what it did. Show, hide, swap, add, remove and
/// reset all end a pending Move.
fn change(app: &mut App, update: impl FnOnce(&HomeArrangement) -> HomeArrangement, message: String) {
    app.pages.home.edit.moving = None;
    let next = update(&arrangement(app));
    save(app, &next);
    app.pages.home.edit.announcement = message;
}

pub fn swap(app: &mut App, from: &str, to: &str) {
    if from == to {
        return;
    }
    let message = format!("Swapped {} and {}.", label_by_id(app, from), label_by_id(app, to));
    let (a, b) = (from.to_string(), to.to_string());
    change(app, |cur| swap_panels(cur, &a, &b), message);
}

pub fn hide(app: &mut App, id: &str) {
    let message = format!("{} hidden.", label_by_id(app, id));
    change(app, |cur| set_panel_hidden(cur, id, true), message);
}

pub fn show(app: &mut App, id: &str) {
    let message = format!("{} shown.", label_by_id(app, id));
    change(app, |cur| set_panel_hidden(cur, id, false), message);
}

/// Add panel's Add (or Show, for a hidden one of a kind). Says which panel
/// it put on the board.
pub fn add(app: &mut App, kind: PanelKind, period: Option<Period>, playlist: Option<String>) -> Option<String> {
    app.pages.home.edit.dialog = None;
    let current = arrangement(app);
    let (next, id) = add_panel(&current, kind, period, playlist);
    let id = id?;
    let shown_again = find_panel(&current, &id).is_some();
    let label = find_panel(&next, &id).map(|p| label_of(app, p)).unwrap_or_default();
    change(app, |_| next, format!("{label} {}.", if shown_again { "shown" } else { "added" }));
    Some(id)
}

pub fn remove(app: &mut App, id: &str) {
    let message = format!("{} removed.", label_by_id(app, id));
    app.pages.home.edit.dialog = None;
    change(app, |cur| remove_panel(cur, id), message);
}

/// The panels the user added, which a reset throws away.
pub fn added(app: &App) -> Vec<HomePanel> {
    arrangement(app).panels.into_iter().filter(|p| !DEFAULT_PANEL_IDS.iter().any(|k| k.id() == p.id)).collect()
}

pub fn reset_now(app: &mut App) {
    app.pages.home.edit.dialog = None;
    change(app, |_| default_arrangement(), "Home is back to its default layout.".into());
}

/// Reset: asks first when it would throw away added panels.
pub fn reset_board(app: &mut App) {
    app.pages.home.edit.moving = None;
    if is_default_arrangement(&arrangement(app)) {
        return;
    }
    if added(app).is_empty() {
        reset_now(app);
    } else {
        app.pages.home.edit.dialog = Some(Dialog::Reset);
    }
}

/// Done: leave customizing (`setEditing(false)`).
pub fn done(app: &mut App) {
    app.pages.home.edit.moving = None;
    app.navigate_replace(Location::parse("/"));
}

/// Escape: ends a Move, else leaves customizing. A dialog answers Escape
/// itself.
pub fn on_key(app: &mut App, ev: &KeyEvent, _tx: &mut Tx) -> bool {
    if !app.location().is("/") || !app.location().has(super::arrangement::CUSTOMIZE_PARAM) {
        return false;
    }
    if app.pages.home.edit.dialog.is_some() || ev.key != Key::Escape {
        return false;
    }
    if app.pages.home.edit.moving.is_some() {
        app.pages.home.edit.moving = None;
    } else {
        done(app);
    }
    true
}

// ── The slot ────────────────────────────────────────────────────────────────

/// `BoardSlot`: the panel at `rect`, and while editing a tile over it that
/// drags and holds Move and Hide. The panel underneath goes inert, so nothing
/// in it plays or opens mid-arrangement.
#[allow(clippy::too_many_arguments)]
pub fn slot(
    app: &App,
    t: &Theme,
    m: &Model,
    panel: &HomePanel,
    next: Option<String>,
    rect: [f32; 4],
    rects: &[[f32; 4]],
    panels: &[HomePanel],
    body: El,
) -> El {
    let [x, y, w, h] = rect;
    let mut s = el().key(format!("slot-{}", panel.id)).absolute(x, y).size(w, h);
    if !m.editing {
        return s.child(body);
    }
    let e = &app.pages.home.edit;
    let id = panel.id.clone();
    let dragging = e.dragging.as_deref() == Some(&id);
    let lit = e.moving.as_deref() == Some(&id) || e.target.as_deref() == Some(&id);
    s = s.child(body.inert());
    if dragging {
        s = s.opacity(0.4);
    }
    // The tile: frosted over the panel, with its label card in the middle.
    let r = t.radius_xl();
    let mut tile = el()
        .key(format!("slot-{id}-editor"))
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .center()
        .padding(16.0)
        .radius(r)
        .backdrop_blur(10.0)
        .fill(t.c.card.alpha(if lit { 0.86 } else { 0.72 }))
        .role("group")
        .label(label_of(app, panel))
        .cursor(Cursor::Grab);
    tile = if lit {
        tile.border(2.0, t.c.primary)
    } else {
        tile.border(1.0, t.c.foreground.alpha(0.3)).border_dash(3.0, 2.0)
    };
    tile = tile.child(label_card(app, t, m, panel, next));
    // Dragging onto another panel swaps the two.
    let targets: Vec<(String, [f32; 4])> = panels.iter().zip(rects).map(|(p, r)| (p.id.clone(), *r)).collect();
    let (ox, oy) = (x, y);
    tile = tile.on_drag(move |app: &mut App, d, _tx| {
        let px = ox + d.x;
        let py = oy + d.y;
        let over = targets
            .iter()
            .find(|(_, r)| px >= r[0] && px < r[0] + r[2] && py >= r[1] && py < r[1] + r[3])
            .map(|(pid, _)| pid.clone())
            .filter(|pid| *pid != id);
        let e = &mut app.pages.home.edit;
        match d.phase {
            Phase::Down => {}
            Phase::Move => {
                if d.dx.abs() + d.dy.abs() > 4.0 {
                    e.moving = None;
                    e.dragging = Some(id.clone());
                    e.target = over;
                    e.drag_offset = [d.dx, d.dy];
                }
            }
            Phase::Up => {
                let from = e.dragging.take();
                e.target = None;
                if let (Some(from), Some(to), false) = (from, over, d.cancelled()) {
                    swap(app, &from, &to);
                }
            }
        }
    });
    s.child(tile)
}

/// The drag image: the dragged panel's tile, translucent, under the pointer
/// (the browser's drag image of the slot).
pub fn ghost(app: &App, t: &Theme, m: &Model, panel: &HomePanel, rect: [f32; 4]) -> El {
    let [dx, dy] = app.pages.home.edit.drag_offset;
    let r = t.radius_xl();
    el().key("board-drag-image")
        .absolute(rect[0] + dx, rect[1] + dy)
        .size(rect[2], rect[3])
        .center()
        .padding(16.0)
        .radius(r)
        .fill(t.c.card.alpha(0.72))
        .border(1.0, t.c.foreground.alpha(0.3))
        .border_dash(3.0, 2.0)
        .opacity(0.6)
        .inert()
        .child(label_card(app, t, m, panel, None))
}

/// `SlotEditor`'s card: grip, name, what it shows, and its buttons.
fn label_card(app: &App, t: &Theme, m: &Model, panel: &HomePanel, next: Option<String>) -> El {
    let e = &app.pages.home.edit;
    let id = panel.id.clone();
    let title = title_of(app, panel);
    let label = label_of(app, panel);
    let state = match e.moving.as_deref() {
        Some(mv) if mv == id => "moving",
        Some(_) => "target",
        None => "idle",
    };
    let a = t.c.shadow_md_alpha;
    let mut card = crate::ui::css_border(col(), 1.0, t.c.border, t.radius_lg())
        .key(format!("slot-{id}-label"))
        .items_center()
        .gap(4.0)
        .px(17.0)
        .py(13.0)
        .radius(t.radius_lg())
        .fill(t.c.card)
        .box_shadow(rune::Shadow { x: 0.0, y: 4.0, blur: 6.0, spread: -1.0, color: Color::BLACK.alpha(a), inset: false })
        .box_shadow(rune::Shadow { x: 0.0, y: 2.0, blur: 4.0, spread: -2.0, color: Color::BLACK.alpha(a), inset: false })
        .child(ico(&i::GRIP_VERTICAL, 16.0, t.c.muted_foreground))
        .child(lh(text(title).font(font(16.0, 600.0)).color(t.c.card_foreground).wrap_anywhere(), 23.2));
    if panel.kind.info().period {
        card = card.child(lh(text(period_sub(panel.period)).font(font(12.0, 400.0)).color(t.c.muted_foreground), 17.4));
    }
    if let Some(note) = m.note_for(app, panel) {
        card = card.child(lh(text(note).font(font(12.0, 400.0)).color(t.c.muted_foreground).wrap(), 17.4));
    }
    let mut actions = row().mt(8.0).gap(8.0).flex_wrap().justify_center();
    if state == "target" {
        let target = id.clone();
        actions = actions.child(
            Btn::new(format!("slot-{id}-swap"), "Swap here")
                .small()
                .primary()
                .icon(&i::ARROW_LEFT_RIGHT)
                .build(t)
                .label(format!("Swap here with {label}"))
                .on_press(move |app: &mut App| {
                    if let Some(from) = app.pages.home.edit.moving.clone() {
                        swap(app, &from, &target);
                    }
                }),
        );
    } else {
        let moving = state == "moving";
        let mid = id.clone();
        let announce = format!("Moving {label}. Choose Swap here on another panel, or press Escape to cancel.");
        actions = actions.child(
            Btn::new(format!("slot-{id}-move"), if moving { "Cancel move" } else { "Move" })
                .small()
                .icon(&i::ARROW_LEFT_RIGHT)
                .build(t)
                .label(format!("{} {label}", if moving { "Cancel move" } else { "Move" }))
                .checked(moving)
                .on_press(move |app: &mut App| {
                    let e = &mut app.pages.home.edit;
                    if moving {
                        e.moving = None;
                    } else {
                        e.moving = Some(mid.clone());
                        e.announcement = announce.clone();
                    }
                }),
        );
    }
    if state == "idle" {
        let (eid, next) = (id.clone(), next.clone());
        actions = actions.child(
            Btn::new(format!("slot-{id}-edit"), "Edit")
                .small()
                .icon(&i::SLIDERS_HORIZONTAL)
                .build(t)
                .label(format!("Edit {label}"))
                .on_press(move |app: &mut App| {
                    app.pages.home.edit.moving = None;
                    super::dialogs::open_settings(app, &eid, next.clone());
                }),
        );
    }
    if state != "moving" {
        let hid = id.clone();
        actions = actions.child(
            Btn::new(format!("slot-{id}-hide"), "Hide")
                .small()
                .ghost()
                .icon(&i::EYE_OFF)
                .build(t)
                .label(format!("Hide {label}"))
                .on_press(move |app: &mut App| hide(app, &hid)),
        );
    }
    card.child(actions)
}

// ── The bar ─────────────────────────────────────────────────────────────────

/// `BoardEditBar`: what customizing does, the hidden panels to show again,
/// Add panel, Reset and Done. Sticks to the top of the page. `width` is the
/// bar's own width: it wraps its three groups the way its flexbox does (the
/// text on a 240 px basis, growing; the actions pushed to the end).
pub fn bar(app: &App, t: &Theme, m: &Model, width: f32) -> El {
    let e = &app.pages.home.edit;
    let moving = e.moving.as_deref().and_then(|id| find_panel(&m.arrangement, id)).map(|p| label_of(app, p));
    let hint = match &moving {
        Some(l) => format!("Choose where {l} goes."),
        None => "Drag a panel onto another to swap them, or edit one to change its size and what it shows.".into(),
    };
    let inner = width - 34.0;
    let hidden: Vec<&HomePanel> = m.arrangement.panels.iter().filter(|p| p.hidden).collect();
    let chip_w = |label: &str| 2.0 + 10.0 + 14.0 + 4.0 + measure(label, font(13.0, 500.0)) + 10.0;
    let hidden_w = if hidden.is_empty() {
        0.0
    } else {
        measure("Hidden", font(12.0, 500.0)) + 2.0 + hidden.iter().map(|p| 8.0 + chip_w(&label_of(app, p))).sum::<f32>()
    };
    let small = |label: &str| 2.0 + 10.0 + 14.0 + 4.0 + measure(label, font(13.0, 500.0)) + 10.0;
    let actions_w = small("Add panel") + 8.0 + small("Reset") + 8.0 + small("Done");
    // Flex lines: the text (240 px), then the hidden chips, then the actions,
    // each on the line before when it fits.
    let mut lines: Vec<Vec<u8>> = vec![vec![0]];
    let mut used = 240.0f32.min(inner);
    let mut place = |item: u8, w: f32, lines: &mut Vec<Vec<u8>>| {
        if used + 24.0 + w <= inner {
            used += 24.0 + w;
            lines.last_mut().unwrap().push(item);
        } else {
            used = w.min(inner);
            lines.push(vec![item]);
        }
    };
    if !hidden.is_empty() {
        place(1, hidden_w, &mut lines);
    }
    place(2, actions_w, &mut lines);

    let text_block = |w: f32| {
        let hint_h = (rune::text::measure(&hint, &[], font(13.0, 400.0), Some(w)).1 / 18.85).round().max(1.0) * 18.85;
        col()
            .grow(1.0)
            .min_w(0.0)
            .child(lh(text("Customize Home").font(font(16.0, 600.0)).color(t.c.card_foreground), 23.2))
            .child(lh(text(hint.clone()).font(font(13.0, 400.0)).color(t.c.muted_foreground).wrap(), hint_h).mt(2.0))
    };
    let hidden_group = || {
        let mut h = row()
            .key("board-editbar-hidden")
            .flex_wrap()
            .items_center()
            .gap(8.0)
            .min_w(0.0)
            .max_w(inner)
            .role("group")
            .label("Hidden panels")
            .child(text("Hidden").font(font(12.0, 500.0)).color(t.c.muted_foreground).mr(2.0));
        for p in &hidden {
            let label = label_of(app, p);
            let id = p.id.clone();
            h = h.child(chip(t, &format!("board-show-{}", p.id), &label).on_press(move |app: &mut App| show(app, &id)));
        }
        h
    };
    let is_default = is_default_arrangement(&m.arrangement);
    let actions = || {
        row()
            .key("board-editbar-actions")
            .items_center()
            .gap(8.0)
            .child(
                Btn::new("board-add-panel", "Add panel").small().icon(&i::PLUS).build(t).on_press(|app: &mut App| {
                    app.pages.home.edit.moving = None;
                    super::dialogs::open_add(app);
                }),
            )
            // Not disabled while the board is the default: it does nothing then.
            .child(
                Btn::new("board-reset", "Reset").small().ghost().icon(&i::ROTATE_CCW).build(t).disabled(is_default).on_press(reset_board),
            )
            .child(Btn::new("board-done", "Done").small().primary().icon(&i::CHECK).build(t).on_press(done))
    };

    let a = t.c.shadow_md_alpha;
    let r = t.radius_xl();
    let mut b = crate::ui::css_border(col(), 1.0, t.c.border, r)
        .key("board-editbar")
        .w_full()
        .gap(12.0)
        .mb(t.gap())
        .px(17.0)
        .py(13.0)
        .radius(r)
        .fill(t.c.card)
        .box_shadow(rune::Shadow { x: 0.0, y: 4.0, blur: 6.0, spread: -1.0, color: Color::BLACK.alpha(a), inset: false })
        .box_shadow(rune::Shadow { x: 0.0, y: 2.0, blur: 4.0, spread: -2.0, color: Color::BLACK.alpha(a), inset: false })
        .sticky_top(0.0)
        .role("region")
        .label("Customize Home");
    for items in lines {
        // The text takes what the line's other groups leave.
        let others: f32 = items
            .iter()
            .map(|i| match i {
                1 => hidden_w.min(inner) + 24.0,
                2 => actions_w + 24.0,
                _ => 0.0,
            })
            .sum();
        let mut l = row().w_full().gap(24.0).items_center();
        if !items.contains(&0) {
            l = l.justify_between();
            if items == [2] {
                l = l.justify_end();
            }
        }
        for item in items {
            l = l.child(match item {
                0 => text_block(inner - others),
                1 => hidden_group(),
                _ => actions(),
            });
        }
        b = b.child(l);
    }
    b.child(
        el().absolute(0.0, 0.0)
            .size(0.0, 0.0)
            .role("status")
            .label(e.announcement.clone())
            .live_region(rune::LiveRegion::Polite),
    )
}

fn measure(s: &str, style: rune::TextStyle) -> f32 {
    rune::text::measure(s, &[], style, None).0
}

/// A hidden panel's chip: Show, with its name cut short when long.
fn chip(t: &Theme, key: &str, label: &str) -> El {
    let ink = t.c.foreground;
    crate::ui::css_border(row(), 1.0, t.c.input, t.radius_md().min(12.0))
        .key(key.to_string())
        .h(28.0)
        .px(10.0)
        .gap(4.0)
        .min_w(0.0)
        .shrink()
        .items_center()
        .radius(t.radius_md().min(12.0))
        .fill(t.c.input_bg)
        .hover(crate::ui::hover_overlay(t.c.input_bg, t.c.input_bg_hover))
        .press_scale(0.97)
        .cursor(Cursor::Pointer)
        .focusable(true)
        .role("button")
        .label(format!("Show {label}"))
        .help(label.to_string())
        .child(ico(&i::EYE, 14.0, ink))
        .child(line(label.to_string(), with_lh(font(13.0, 500.0), 18.85), ink))
}
