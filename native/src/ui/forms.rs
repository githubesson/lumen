//! Form controls: `Select.tsx` (the custom listbox), `SearchInput.tsx`,
//! `Field.tsx` (`Field`, `FieldRow`), `SettingRow.tsx`, `Fieldset.tsx`.

use rune::{Align, Color, Cursor, El, Side, TextEdit, col, el, row, text};

use crate::app::App;
use crate::theme::{Theme, color_mix};
use crate::ui::{css_border, font, ico, icons as i, line, with_lh};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SelectVariant {
    /// `.input`-styled full-width trigger.
    #[default]
    Outlined,
    /// Text and chevron only (`text-sm text-muted-foreground`).
    Minimal,
    /// Inside a `.toolbar-group`.
    Toolbar,
    /// `<NativeSelect>`: a `<select class="input">` as Chromium draws it,
    /// with its own arrow.
    Native,
}

/// Chromium's `<select>` arrow: a short heavy chevron.
const NATIVE_ARROW: rune::Icon = rune::Icon {
    name: "native-select-arrow",
    view: 24.0,
    body: r#"<path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

#[derive(Clone, Debug, PartialEq)]
pub struct SelectOption {
    pub value: String,
    pub label: String,
    pub title: Option<String>,
    pub disabled: bool,
}

impl SelectOption {
    pub fn new(value: impl Into<String>, label: impl Into<String>) -> SelectOption {
        SelectOption { value: value.into(), label: label.into(), title: None, disabled: false }
    }
}

/// The one open select (only one listbox is ever open).
#[derive(Clone)]
pub struct OpenSelect {
    pub key: String,
    pub options: Vec<SelectOption>,
    pub value: String,
    pub variant: SelectVariant,
    pub on_change: fn(&mut App, &str),
    /// The highlighted option (Radix's `data-highlighted`): the current one
    /// as it opens, then wherever the pointer or the arrow keys take it.
    pub highlight: Option<usize>,
}

impl OpenSelect {
    pub fn new(key: impl Into<String>, options: Vec<SelectOption>, value: impl Into<String>, variant: SelectVariant, on_change: fn(&mut App, &str)) -> OpenSelect {
        let value = value.into();
        let highlight = options.iter().position(|o| o.value == value && !o.disabled);
        OpenSelect { key: key.into(), options, value, variant, on_change, highlight }
    }
}

/// The open listbox's keys: Up and Down move the highlight over the
/// enabled options, Home and End jump, Return picks, Escape closes.
pub fn on_key(app: &mut App, ev: &rune::KeyEvent) -> bool {
    use rune::Key;
    let Some(open) = app.select.as_mut() else { return false };
    let enabled: Vec<usize> = open.options.iter().enumerate().filter(|(_, o)| !o.disabled).map(|(n, _)| n).collect();
    let at = open.highlight.and_then(|h| enabled.iter().position(|&n| n == h));
    let next = match ev.key {
        Key::Down => Some(at.map_or(0, |i| (i + 1).min(enabled.len().saturating_sub(1)))),
        Key::Up => Some(at.map_or(enabled.len().saturating_sub(1), |i| i.saturating_sub(1))),
        Key::Home => Some(0),
        Key::End => Some(enabled.len().saturating_sub(1)),
        Key::Enter => {
            let pick = open.highlight.and_then(|h| open.options.get(h)).map(|o| (o.value.clone(), open.on_change));
            app.select = None;
            if let Some((value, on_change)) = pick {
                on_change(app, &value);
            }
            return true;
        }
        Key::Escape => {
            app.select = None;
            return true;
        }
        _ => return false,
    };
    open.highlight = next.and_then(|i| enabled.get(i).copied());
    true
}

/// `<Select>`: a trigger showing the chosen option, opening a listbox
/// (drawn by [`select_layer`] at the root, above everything).
pub fn select(
    app: &App,
    t: &Theme,
    key: &str,
    options: &[SelectOption],
    value: &str,
    variant: SelectVariant,
    placeholder: &str,
    disabled: bool,
    on_change: fn(&mut App, &str),
) -> El {
    let open = app.select.as_ref().is_some_and(|s| s.key == key);
    let selected = options.iter().find(|o| o.value == value);
    let label = selected.map(|o| o.label.clone()).unwrap_or_else(|| placeholder.to_string());
    let open_spec = OpenSelect::new(key, options.to_vec(), value, variant, on_change);
    let toggle = move |app: &mut App| {
        if app.select.as_ref().is_some_and(|s| s.key == open_spec.key) {
            app.select = None;
        } else {
            app.select = Some(open_spec.clone());
        }
    };
    let mut trigger = match variant {
        SelectVariant::Outlined => {
            let ink = if selected.is_some() { t.c.foreground } else { t.c.muted_foreground };
            let b = css_border(row(), 1.0, if open { t.c.focus_ring } else { t.c.input }, t.radius_lg());
            b.h(32.0)
                .w_full()
                .pl(11.0)
                .pr(11.0)
                .gap(8.0)
                .items_center()
                .radius(t.radius_lg())
                .fill(t.c.input_bg)
                .child(line(label, font(14.0, 400.0), ink).grow(1.0))
                .child(ico(&i::CHEVRONS_UP_DOWN, 14.0, t.c.muted_foreground))
        }
        SelectVariant::Native => {
            let b = css_border(row(), 1.0, if open { t.c.focus_ring } else { t.c.input }, t.radius_lg());
            b.h(32.0)
                .w_full()
                .pl(15.0)
                .gap(4.0)
                .items_center()
                .radius(t.radius_lg())
                .fill(t.c.input_bg)
                .child(line(label, font(14.0, 400.0), t.c.foreground).grow(1.0))
                .child(ico(&NATIVE_ARROW, 18.0, t.c.foreground))
        }
        SelectVariant::Minimal => row()
            .gap(4.0)
            .items_center()
            .radius(t.radius_md())
            .child(line(label, font(14.0, 400.0), t.c.muted_foreground).group_color(t.c.foreground))
            .child(ico(&i::CHEVRONS_UP_DOWN, 14.0, t.c.muted_foreground).group_color(t.c.foreground))
            .hover(Color::TRANSPARENT),
        SelectVariant::Toolbar => {
            let hot = color_mix(t.c.foreground, 0.07, Color::TRANSPARENT);
            let ink = if open { t.c.foreground } else { t.c.muted_foreground };
            let mut b = row()
                .h(26.0)
                .px(9.0)
                .gap(6.0)
                .items_center()
                .radius(t.radius_md())
                .child(text(label).font(font(14.0, 500.0)).color(ink).group_color(t.c.foreground))
                .child(ico(&i::CHEVRONS_UP_DOWN, 14.0, ink).group_color(t.c.foreground))
                .hover(hot)
                .press_scale(0.97);
            if open {
                b = b.fill(hot);
            }
            b
        }
    };
    trigger = trigger.key(key).role("combobox").expanded(open);
    if disabled {
        trigger.opacity(0.5).disabled(true).cursor(Cursor::NotAllowed)
    } else {
        trigger.cursor(Cursor::Pointer).focusable(true).on_press(toggle)
    }
}

/// The root's top layers: what views portaled (`kit::portal`, a page's
/// dialogs), then the open select's listbox, anchored to its trigger (above
/// them, for a select inside a dialog). Mount at the root.
pub fn select_layer(app: &App, t: &Theme, cx: &mut rune::Cx<App>) -> Option<El> {
    // Always there, so a portaled dialog that closes can play its exit.
    let mut top = el().key("top-layers").pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0));
    for layer in crate::ui::kit::take_portals() {
        top = top.child(layer);
    }
    if let Some(listbox) = listbox_layer(app, t, cx) {
        top = top.child(listbox);
    }
    Some(top)
}

fn listbox_layer(app: &App, t: &Theme, cx: &mut rune::Cx<App>) -> Option<El> {
    let open = app.select.as_ref()?;
    let trigger_w = cx.layout_size(&open.key).map_or(160.0, |s| s[0]);
    let mut list = crate::ui::kit::menu_panel(t, &format!("{}-listbox", open.key), None)
        .max_h(240.0)
        .role("listbox")
        .focus_group();
    // The other variants' `min-w-40` / `min-w-44` lose to `.menu`'s 220 px:
    // Tailwind's utilities sit in a cascade layer and menu.css doesn't.
    if matches!(open.variant, SelectVariant::Outlined | SelectVariant::Native) {
        list = list.w(trigger_w);
    }
    let mut items = col();
    for (n, o) in open.options.iter().enumerate() {
        let selected = o.value == open.value;
        let value = o.value.clone();
        let on_change = open.on_change;
        let mut it = row()
            .key(format!("{}-opt-{n}", open.key))
            .w_full()
            .min_h(28.0)
            .px(6.0)
            .py(4.0)
            .gap(6.0)
            .items_center()
            .radius(t.radius_md())
            .role("option")
            .checked(selected)
            .child(line(o.label.clone(), font(14.0, if selected { 500.0 } else { 400.0 }), t.c.popover_foreground).grow(1.0));
        if open.highlight == Some(n) {
            it = it.fill(t.c.accent);
        }
        if selected {
            it = it.child(ico(&i::CHECK, 14.0, t.c.primary));
        }
        if let Some(title) = &o.title {
            it = crate::ui::tooltip::tip(it, &format!("{}-opt-{n}", open.key), title);
        }
        if o.disabled {
            it = it.opacity(0.5).cursor(Cursor::NotAllowed);
        } else {
            it = it
                .cursor(Cursor::Pointer)
                .on_hover_change(move |app: &mut App, inside, _| {
                    if let Some(s) = app.select.as_mut().filter(|_| inside) {
                        s.highlight = Some(n);
                    }
                })
                .on_press(move |app: &mut App| {
                    app.select = None;
                    on_change(app, &value);
                });
        }
        items = items.child(it);
    }
    list = list.child(crate::ui::kit::scroll_area_with(t, &format!("{}-scroll", open.key), items, false).shrink());
    let (align, gap) = match open.variant {
        SelectVariant::Outlined | SelectVariant::Native => (Align::Start, 4.0),
        SelectVariant::Minimal => (Align::End, 4.0),
        SelectVariant::Toolbar => (Align::End, 8.0),
    };
    let catcher = el()
        .key(format!("{}-dismiss", open.key))
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .on_press(|app: &mut App| app.select = None);
    Some(
        el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .modal(false, |app: &mut App| app.select = None)
            .child(catcher)
            .child(list.anchored(open.key.clone(), Side::Bottom, align, gap)),
    )
}

/// Binds a field to its `TextEdit` in the app state.
pub type Bind = fn(&mut App) -> &mut TextEdit;

/// `.input:focus`'s rings round `e` (`.search` takes them too): `0 0 0 1px
/// var(--focus-ring), 0 0 0 4px color-mix(in oklch, var(--ring) 30%,
/// transparent)`.
pub fn focus_rings(t: &Theme, e: El) -> El {
    e.box_shadow(rune::Shadow { x: 0.0, y: 0.0, blur: 0.0, spread: 1.0, color: t.c.focus_ring, inset: false }).box_shadow(rune::Shadow {
        x: 0.0,
        y: 0.0,
        blur: 0.0,
        spread: 4.0,
        color: color_mix(t.c.ring, 0.3, Color::TRANSPARENT),
        inset: false,
    })
}

/// `.input`: the 32 px outlined box (keyed `{key}-box`) round `field`, a
/// [`text_field`]; while `focused` its border takes `--focus-ring` and the
/// [`focus_rings`] go round it.
pub fn input_box(t: &Theme, key: &str, focused: bool, field: El) -> El {
    let b = css_border(el(), 1.0, if focused { t.c.focus_ring } else { t.c.input }, t.radius_lg())
        .key(format!("{key}-box"))
        .h(32.0)
        .w_full()
        .radius(t.radius_lg())
        .fill(t.c.input_bg)
        .items_center();
    let b = if focused { focus_rings(t, b) } else { b };
    b.child(field)
}

/// `.input`'s text field, keyed `key`: one line of `style` in the
/// foreground, the placeholder muted, 10 px in from the box's 1 px border.
/// Bind it with `.on_edit(..)`; give it a `.label(..)` without a visible one.
pub fn text_field(t: &Theme, key: &str, edit: &TextEdit, style: rune::TextStyle, placeholder: &str) -> El {
    rune::text_input(edit, style)
        .key(key)
        .single_line()
        .placeholder(placeholder, t.c.muted_foreground)
        .color(t.c.foreground)
        .caret(t.c.foreground, t.c.selection)
        .selection_color(t.c.selection)
        .grow(1.0)
        .px(11.0)
}

/// `SearchInput`: the `.search` box with a magnifier and a text field.
/// `bind` gets the inner text field, where its `.on_edit(..)`,
/// `.on_input_change(..)`, `.on_input_key(..)` and `.on_submit(..)` go.
pub fn search_input(
    t: &Theme,
    key: &str,
    edit: &TextEdit,
    placeholder: &str,
    width: Option<f32>,
    bind: impl FnOnce(El) -> El,
) -> El {
    let focused = edit.focused;
    let mut b = css_border(row(), 1.0, if focused { t.c.focus_ring } else { t.c.input }, t.radius_lg())
        .key(format!("{key}-box"))
        .h(32.0)
        .pl(11.0)
        .pr(7.0)
        .gap(8.0)
        .items_center()
        .radius(t.radius_lg())
        .fill(t.c.input_bg)
        .min_w(0.0);
    b = match width {
        Some(w) => b.w(w),
        None => b.w_full(),
    };
    if focused {
        b = focus_rings(t, b);
    }
    b.child(ico(&i::SEARCH, 14.0, t.c.muted_foreground)).child(bind(
        rune::text_input(edit, font(14.0, 400.0))
            .key(key)
            .single_line()
            .placeholder(placeholder, t.c.muted_foreground)
            .label(placeholder)
            .color(t.c.foreground)
            .caret(t.c.foreground, t.c.selection)
            .selection_color(t.c.selection)
            .grow(1.0)
            .min_w(0.0),
    ))
}

/// `Field`: a label over a control, with a hint or an error under it.
pub fn field(t: &Theme, label: &str, control: El, hint: Option<&str>, error: Option<&str>) -> El {
    field_in(t, label, control, hint, error, None)
}

/// [`field`] `width` wide, its hint or error boxed as CSS boxes it (whole
/// 17.4 px lines, where rune rounds each text box up).
pub fn field_in(t: &Theme, label: &str, control: El, hint: Option<&str>, error: Option<&str>, width: Option<f32>) -> El {
    let note = |s: &str, color: Color| {
        let style = font(12.0, 400.0);
        let e = text(s).font(style).color(color).wrap();
        match width {
            Some(w) => e.h(crate::ui::css_text_h(s, style, Some(w))),
            None => e,
        }
    };
    let mut c = col().gap(6.0).child(text(label).font(with_lh(font(14.0, 500.0), 14.0)).color(t.c.foreground)).child(control);
    if let Some(e) = error {
        c = c.child(note(e, t.c.destructive).role("alert"));
    } else if let Some(h) = hint {
        c = c.child(note(h, t.c.muted_foreground));
    }
    c
}

/// `FieldRow`: fields side by side in equal columns, 12 px apart.
pub fn field_row(children: Vec<El>) -> El {
    let mut r = row().gap(12.0).w_full();
    for c in children {
        r = r.child(el().grow(1.0).w(0.0).min_w(0.0).child(c.w_full()));
    }
    r
}

/// `SettingRow`'s description: a line of text, or a status line (tabular,
/// red when it failed: the updater's).
pub enum Desc {
    Text(String),
    Status { text: String, error: bool },
}

/// `SettingRow` (`.settings-row`): label (and description) on the left, the
/// control on the right, `below` across the full width, a hairline under it
/// unless `last`.
pub fn setting_row(t: &Theme, label: &str, desc: Option<Desc>, control: Option<El>, below: Option<El>, error: Option<&str>, last: bool) -> El {
    setting_row_in(t, label, desc, control, below, error, last, None)
}

/// [`setting_row`] whose texts are `text_width` wide, boxed as CSS boxes
/// them (whole lines, where rune rounds each text box up). Without a width
/// the description keeps its lines' height from the last layout.
#[allow(clippy::too_many_arguments)]
pub fn setting_row_in(
    t: &Theme,
    label: &str,
    desc: Option<Desc>,
    control: Option<El>,
    below: Option<El>,
    error: Option<&str>,
    last: bool,
    text_width: Option<f32>,
) -> El {
    // One line box as tall as CSS makes it (rune rounds text boxes up).
    let label_style = font(14.0, 400.0);
    let mut title = text(label).font(label_style).color(t.c.foreground);
    title = match text_width {
        Some(w) => title.wrap().h(crate::ui::css_text_h(label, label_style, Some(w))),
        None => title.h(label_style.line_height),
    };
    let mut texts = col().min_w(0.0).shrink().child(title);
    if let Some(d) = desc {
        let style = with_lh(font(12.0, 400.0), 16.8);
        let (d, style, ink) = match d {
            Desc::Text(d) => (d, style, t.c.muted_foreground),
            Desc::Status { text, error } => (text, crate::ui::tnum(style), if error { t.c.destructive } else { t.c.muted_foreground }),
        };
        let h = text_width.map(|w| crate::ui::css_text_h(&d, style, Some(w)));
        let e = text(d).font(style).color(ink).wrap_anywhere();
        texts = texts.child(match h {
            Some(h) => e.h(h).mt(2.0),
            None => crate::ui::snug_lines(&format!("settings-desc-{label}"), e, style.line_height).mt(2.0),
        });
    }
    let mut main = row().min_h(28.0).gap(16.0).items_center().justify_between().child(texts);
    if let Some(c) = control {
        main = main.child(el().child(c));
    }
    let mut r = col().w_full().gap(8.0).pt(14.0).pb(if last { 14.0 } else { 15.0 }).child(main);
    if !last {
        r = crate::ui::css_border_bottom(r, 1.0, t.c.border);
    }
    if let Some(b) = below {
        r = r.child(b);
    }
    if let Some(e) = error {
        r = r.child(text(e).font(font(12.0, 400.0)).color(t.c.destructive).wrap());
    }
    r
}

/// `<Select variant="minimal">` in a setting row's control
/// (`.settings-row-control [role=combobox]`): the value itself in the
/// foreground, like a menu button, then the muted chevrons. Its accessible
/// name is the value unless the caller sets a `.label(..)`.
pub fn setting_select(
    app: &App,
    t: &Theme,
    key: &str,
    options: Vec<SelectOption>,
    value: &str,
    disabled: bool,
    on_change: fn(&mut App, &str),
) -> El {
    let open = app.select.as_ref().is_some_and(|s| s.key == key);
    let label = options.iter().find(|o| o.value == value).map(|o| o.label.clone()).unwrap_or_else(|| "Select…".into());
    let spec = OpenSelect::new(key, options, value, SelectVariant::Minimal, on_change);
    // `padding: 4px 2px 4px 6px` round `text-sm`'s 20 px line.
    let b = row()
        .key(key)
        .h(28.0)
        .pl(6.0)
        .pr(2.0)
        .gap(4.0)
        .items_center()
        .radius(t.radius_md())
        .role("combobox")
        .expanded(open)
        .label(label.clone())
        .child(line(label, with_lh(font(14.0, 400.0), 20.0), t.c.foreground))
        .child(ico(&i::CHEVRONS_UP_DOWN, 14.0, t.c.muted_foreground));
    if disabled {
        return b.opacity(0.5).disabled(true).cursor(Cursor::NotAllowed);
    }
    b.cursor(Cursor::Pointer).focusable(true).on_press(move |app: &mut App| {
        app.select = if app.select.as_ref().is_some_and(|s| s.key == spec.key) { None } else { Some(spec.clone()) };
    })
}
