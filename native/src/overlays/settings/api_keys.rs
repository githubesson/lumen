//! `ApiKeysSetting.tsx` (`settings.css`): the signed-in user's API keys under
//! Connections. Make one (shown once, to copy), see when each was last used,
//! revoke them. The key itself never comes back after it's made, so the list
//! tells keys apart by name and first characters.

use rune::{El, Span, TextEdit, col, el, row, text};

use super::{Desc, RowFn, SettingDef, setting_row};
use crate::api::Role;
use crate::api::auth::{self as api, ApiKey, CreatedApiKey};
use crate::app::App;
use crate::core::dates::{now_ms, parse};
use crate::format::fmt_date;
use crate::overlays::confirm::{self, Art, ConfirmSpec};
use crate::resource::{Res, load};
use crate::theme::Theme;
use crate::ui::forms::{OpenSelect, SelectOption, SelectVariant, input_box, text_field};
use crate::ui::track_row::badge;
use crate::ui::{Btn, css_border_bottom, font, ico, icons as i, line, mono, snug_lines, with_lh};

const KEYWORDS: &str = "api keys key token bearer scripts programs automation developer revoke";

/// `EXPIRY`: days, and the select's label.
const EXPIRY: [(u32, &str); 4] =
    [(0, "Never expires"), (30, "Expires in 30 days"), (90, "Expires in 90 days"), (365, "Expires in a year")];

#[derive(Default)]
pub struct State {
    pub keys: Res<Vec<ApiKey>>,
    pub name: TextEdit,
    /// Days until the next key expires; 0 never.
    pub expiry: u32,
    pub creating: bool,
    pub error: Option<String>,
    /// The key just made, shown to copy until the dialog closes.
    pub created: Option<CreatedApiKey>,
    pub copied: crate::ui::flash::Flag,
}

fn keys_res(app: &mut App) -> Option<&mut Res<Vec<ApiKey>>> {
    Some(&mut app.overlays.settings.api_keys.keys)
}

/// The dialog opened: load the keys.
pub fn on_open(app: &mut App) {
    load(app, keys_res, api::list_api_keys, "Couldn't load your API keys.", |_| {});
}

/// The dialog closed: forget the form, the key shown and the list (the next
/// user on this computer mustn't see the last one's key names).
pub fn on_close(app: &mut App) {
    app.overlays.settings.api_keys = State::default();
}

fn is_expired(key: &ApiKey, now: i64) -> bool {
    key.expires_at.as_deref().and_then(parse).is_some_and(|at| at <= now)
}

fn last_used(key: &ApiKey) -> String {
    key.last_used_at.as_deref().map_or_else(|| "Never used".into(), |at| format!("Last used {}", fmt_date(at)))
}

/// "Created Nov 24, 2026 · Last used Nov 25, 2026 · Expires Dec 24, 2026".
fn key_dates(key: &ApiKey, now: i64) -> String {
    let mut parts = vec![format!("Created {}", fmt_date(&key.created_at)), last_used(key)];
    // An expired key says so in its badge.
    if let Some(at) = key.expires_at.as_deref().filter(|_| !is_expired(key, now)) {
        parts.push(format!("Expires {}", fmt_date(at)));
    }
    parts.join(" · ")
}

fn create(app: &mut App) {
    let s = &mut app.overlays.settings.api_keys;
    let name = s.name.text.trim().to_string();
    // A second submit while one is out would make a second key.
    if s.creating || name.is_empty() {
        return;
    }
    let Some(client) = app.client.clone() else { return };
    let days = s.expiry;
    s.creating = true;
    s.error = None;
    let session = app.overlays.settings.session;
    app.net.run(
        move || api::create_api_key(&client, &name, days),
        move |app, result| {
            if app.overlays.settings.session != session {
                return;
            }
            let s = &mut app.overlays.settings.api_keys;
            s.creating = false;
            match result {
                Ok(made) => {
                    // The list never holds the key itself. A list that hasn't
                    // loaded yet, or failed to, loads afresh with the new key
                    // in it: adding to nothing would show the new key alone.
                    let listed = made.listed.clone();
                    let loaded = s.keys.data.is_some();
                    if loaded {
                        s.keys.update(|list| {
                            list.retain(|k| k.id != listed.id);
                            list.insert(0, listed);
                        });
                    }
                    s.created = Some(made);
                    s.name = TextEdit::new("");
                    s.copied.clear();
                    if !loaded {
                        on_open(app);
                    }
                }
                Err(e) => {
                    s.error = Some(crate::api::error_message(&e, "Couldn't make the key."));
                    s.name.focused = true;
                }
            }
        },
    );
}

fn revoke(app: &mut App, key: &ApiKey) {
    let id = key.id.clone();
    let gone = key.id.clone();
    let spec = ConfirmSpec::new("Revoke this API key?", "Anything using it stops working right away.", "Revoke")
        .subject(Art::Icon(&i::KEY_ROUND), key.name.clone(), Some(format!("{}… · {}", key.prefix, last_used(key))))
        .icon(&i::TRASH_2)
        .busy_label("Revoking…")
        .error_fallback("Couldn't revoke the key.");
    confirm::ask_action(
        app,
        spec,
        move |c| match api::delete_api_key(c, &id) {
            // Revoked already, from another window.
            Err(e) if e.has_status(404) => Ok(()),
            r => r,
        },
        move |app| {
            let s = &mut app.overlays.settings.api_keys;
            s.keys.update(|list| list.retain(|k| k.id != gone));
            if s.created.as_ref().is_some_and(|c| c.listed.id == gone) {
                s.created = None;
            }
        },
    );
}

fn copy(app: &mut App, tx: &mut rune::Tx) {
    let Some(key) = app.overlays.settings.api_keys.created.as_ref().map(|c| c.key.clone()) else { return };
    tx.copy(key);
    crate::ui::flash::flash(app, |app| &mut app.overlays.settings.api_keys.copied, 2000);
}

/// The API keys setting: the form row, then a row per key.
pub fn settings<'a>(app: &'a App, t: &'a Theme) -> SettingDef<'a> {
    let now = now_ms();
    let mut rows: Vec<RowFn<'a>> = vec![Box::new(move |last| form_row(app, t, last))];
    for key in app.overlays.settings.api_keys.keys.data.iter().flatten() {
        rows.push(Box::new(move |last| key_row(t, key, now, last)));
    }
    SettingDef { keywords: KEYWORDS, rows }
}

/// Where scripts send the key: the server this app uses.
fn server(app: &App) -> String {
    let configured = super::desktop_bridge::config(app).backend_url;
    let base = if configured.is_empty() { app.client.as_ref().map_or(String::new(), |c| c.base().to_string()) } else { configured };
    base.trim_end_matches('/').to_string()
}

fn form_row(app: &App, t: &Theme, last: bool) -> El {
    let s = &app.overlays.settings.api_keys;
    let admin = app.me().is_some_and(|me| me.role == Role::Admin);
    let description = if admin {
        "Scripts and other programs use a key to call Lumen's API as you, admin rights included. Changing your password revokes every key."
    } else {
        "Scripts and other programs use a key to call Lumen's API as you. Changing your password revokes every key."
    };

    // `.input.settings-input`, read-only while the key is made.
    let mut field = text_field(t, "settings-api-key-name", &s.name, font(12.0, 400.0), "Name it after what uses it").label("Key name").min_w(0.0);
    if !s.creating {
        field = field.on_edit(|app: &mut App| &mut app.overlays.settings.api_keys.name);
    }
    field = field.on_submit(|app: &mut App, _| create(app));
    let name = input_box(t, "settings-api-key-name", s.name.focused, field).min_w(0.0);
    let expiry = expiry_select(app, t, s.expiry, s.creating);
    let create_btn = Btn::new("settings-api-key-create", if s.creating { "Creating…" } else { "Create" })
        .small()
        .disabled(s.creating || s.name.text.trim().is_empty())
        .build(t)
        .on_press(create);
    // `.settings-copy.api-key-form`: the name takes the room the others leave.
    let form = row().w_full().gap(8.0).items_center().child(el().grow(1.0).min_w(0.0).child(name)).child(expiry).child(create_btn);

    let mut below = col().w_full().gap(8.0).child(form);
    if let Some(made) = &s.created {
        below = below.child(created(app, t, made));
    }
    let error = s.error.as_deref().or(s.keys.error.as_deref());
    setting_row(t, "API keys", Some(Desc::Text(description.into())), None, Some(below), error, last)
}

/// The expiry's `<Select variant="minimal">`. Outside `.settings-row-control`
/// it has no padding, and as `text-muted-foreground` matches no rule in the
/// web app's CSS, its value and chevron take the dialog's foreground.
fn expiry_select(app: &App, t: &Theme, days: u32, disabled: bool) -> El {
    const KEY: &str = "settings-api-key-expiry";
    let options: Vec<SelectOption> = EXPIRY.iter().map(|(d, l)| SelectOption::new(d.to_string(), *l)).collect();
    let label = EXPIRY.iter().find(|(d, _)| *d == days).map_or(EXPIRY[0].1, |(_, l)| *l);
    let open = app.select.as_ref().is_some_and(|s| s.key == KEY);
    let spec = OpenSelect::new(KEY, options, days.to_string(), SelectVariant::Minimal, |app, v| {
        app.overlays.settings.api_keys.expiry = v.parse().unwrap_or(0);
    });
    let b = row()
        .key(KEY)
        .h(20.0)
        .gap(4.0)
        .items_center()
        .radius(t.radius_md())
        .role("combobox")
        .expanded(open)
        .label("Expiry")
        .child(line(label, with_lh(font(14.0, 400.0), 20.0), t.c.foreground))
        .child(ico(&i::CHEVRONS_UP_DOWN, 14.0, t.c.foreground));
    if disabled {
        return b.opacity(0.5).disabled(true).cursor(rune::Cursor::NotAllowed);
    }
    b.cursor(rune::Cursor::Pointer).focusable(true).on_press(move |app: &mut App| {
        app.select = if app.select.as_ref().is_some_and(|s| s.key == spec.key) { None } else { Some(spec.clone()) };
    })
}

/// `.api-key-created`: the key just made, to copy, and how to send it.
fn created(app: &App, t: &Theme, made: &CreatedApiKey) -> El {
    let s = &app.overlays.settings.api_keys;
    let copied = s.copied.on();
    // `.input.settings-input` in `--font-mono`, read-only.
    let edit = TextEdit::new(made.key.clone());
    let field = text_field(t, "settings-api-key-new", &edit, mono(12.0, 400.0), "").label(format!("New key “{}”", made.listed.name)).min_w(0.0);
    let copy_btn = Btn::new("settings-api-key-copy", if copied { "Copied" } else { "Copy" })
        .small()
        .icon(if copied { &i::CHECK } else { &i::CLIPBOARD })
        .build(t)
        .on_press_tx(copy);
    let key_line = row()
        .w_full()
        .gap(8.0)
        .items_center()
        .child(el().grow(1.0).min_w(0.0).child(input_box(t, "settings-api-key-new", false, field).min_w(0.0)))
        .child(copy_btn);

    // `.settings-row-desc` with the header and the address in `--font-mono`.
    let lead = "Copy it now: Lumen won't show it again. Send it as ";
    let header = "Authorization: Bearer <key>";
    let url = format!("{}/api", server(app));
    let hint = format!("{lead}{header} to {url}.");
    let url_at = lead.len() + header.len() + " to ".len();
    let style = with_lh(font(12.0, 400.0), 16.8);
    let note = text(hint)
        .font(style)
        .color(t.c.muted_foreground)
        .spans(vec![Span::new(lead.len(), lead.len() + header.len()).mono(), Span::new(url_at, url_at + url.len()).mono()])
        .wrap_anywhere();
    col()
        .key("settings-api-key-created")
        .w_full()
        .gap(6.0)
        .role("status")
        .child(key_line)
        .child(snug_lines("settings-api-key-hint", note, style.line_height).mt(2.0))
}

/// A key's own row (`SettingRow` with a rich label and description): its
/// name, "Expired" when it is, the prefix in mono and its dates; Revoke.
fn key_row(t: &Theme, key: &ApiKey, now: i64, last: bool) -> El {
    // `.api-key-name`: one 14 px line box, the badge beside the name.
    let mut label = row().h(20.3).gap(8.0).items_center().min_w(0.0).child(line(key.name.clone(), font(14.0, 400.0), t.c.foreground).shrink());
    if is_expired(key, now) {
        label = label.child(badge(t, "Expired"));
    }
    let lead = format!("{}…", key.prefix);
    let style = with_lh(font(12.0, 400.0), 16.8);
    let desc = text(format!("{lead} · {}", key_dates(key, now)))
        .font(style)
        .color(t.c.muted_foreground)
        .spans(vec![Span::new(0, lead.len()).mono()])
        .wrap_anywhere();
    let texts = col().min_w(0.0).shrink().child(label).child(snug_lines(&format!("settings-api-key-desc-{}", key.id), desc, style.line_height).mt(2.0));
    let item = key.clone();
    let revoke_btn = Btn::new(format!("settings-api-key-revoke-{}", key.id), "Revoke")
        .small()
        .build(t)
        .label(format!("Revoke {}", key.name))
        .on_press(move |app: &mut App| revoke(app, &item));
    let main = row().min_h(28.0).gap(16.0).items_center().justify_between().child(texts).child(el().child(revoke_btn));
    let r = col().key(format!("settings-api-key-{}", key.id)).w_full().gap(8.0).pt(14.0).pb(if last { 14.0 } else { 15.0 }).child(main);
    if last { r } else { css_border_bottom(r, 1.0, t.c.border) }
}

/// Scene: a key just made, its value shown once.
pub fn scene_created(app: &mut App) {
    let s = &mut app.overlays.settings.api_keys;
    let made = CreatedApiKey {
        listed: ApiKey {
            id: "key-new".into(),
            name: "Stats script".into(),
            prefix: "lumen_Wm3hT8".into(),
            created_at: "2026-10-11T08:00:00Z".into(),
            last_used_at: None,
            expires_at: None,
        },
        key: "lumen_Wm3hT8rQ0yJ5nCkVb1sXe7uPa4dLg2fZoK9iR6wHq".into(),
    };
    let listed = made.listed.clone();
    s.keys.update(|list| list.insert(0, listed));
    s.created = Some(made);
}

/// Scene: the question before revoking the first key.
pub fn scene_revoke(app: &mut App) {
    if let Some(key) = app.overlays.settings.api_keys.keys.data.as_ref().and_then(|k| k.first()).cloned() {
        revoke(app, &key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(expires_at: Option<&str>, last_used_at: Option<&str>) -> ApiKey {
        ApiKey {
            id: "k".into(),
            name: "n".into(),
            prefix: "lumen_AbCdEf".into(),
            created_at: "2026-10-02T09:14:00Z".into(),
            last_used_at: last_used_at.map(str::to_string),
            expires_at: expires_at.map(str::to_string),
        }
    }

    #[test]
    fn only_a_key_past_its_date_is_expired() {
        let now = parse("2026-11-24T10:00:00Z").unwrap();
        assert!(!is_expired(&key(None, None), now));
        assert!(!is_expired(&key(Some("2026-12-01T00:00:00Z"), None), now));
        assert!(is_expired(&key(Some("2026-11-01T00:00:00Z"), None), now));
    }

    #[test]
    fn dates_leave_out_the_expiry_once_it_has_passed() {
        let now = parse("2026-11-24T10:00:00Z").unwrap();
        let live = key_dates(&key(Some("2099-03-12T18:02:00Z"), None), now);
        assert!(live.starts_with("Created ") && live.contains(" · Never used · Expires "), "{live}");
        let gone = key_dates(&key(Some("2025-09-01T10:00:00Z"), Some("2025-08-30T21:15:00Z")), now);
        assert!(gone.contains(" · Last used ") && !gone.contains("Expires"), "{gone}");
    }
}
