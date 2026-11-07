//! The menu's items run (`lib/trackMenu.ts`'s `run*`): play, favourite,
//! download, the album, adding to a playlist, and the confirmed deletes.


use super::{Item, Menu, THUMB, close, menu_for, reload_playlists, subline, take};
use crate::api::{self, Client, TrackListItem, error_message};
use crate::app::App;
use crate::core::entity_target::{resolve_track_album_target_with, track_album_target};
use crate::core::track_menu::{PLAYLIST_ADD_BATCH, add_batches, favorite_toggle_ids};
use crate::format::display_text;
use crate::ui::icons as i;
use crate::ui::track_row;

/// An item's action. Most close the menu first.
pub(super) fn run(app: &mut App, item: Item) {
    match item {
        Item::Play => {
            if let Some(m) = take(app) {
                play(app, m);
            }
        }
        Item::Fav => {
            if let Some(m) = take(app) {
                favorite(app, m);
            }
        }
        Item::Share => {
            if let Some(m) = take(app) {
                crate::overlays::share::open(app, &m.track.id);
            }
        }
        Item::Download => download(app),
        Item::Export => {
            if let Some((key, source)) = take(app).and_then(|m| m.ctx.selection).and_then(|s| s.list) {
                crate::ui::track_select::export_selected(app, &key, source);
            }
        }
        Item::ViewAlbum => view_album(app),
        Item::Info => {
            if let Some(m) = take(app) {
                crate::overlays::track_info::open(app, &m.track.id);
            }
        }
        Item::Retry => {
            if let Some(m) = app.overlays.track_menu.menu.as_mut() {
                m.playlists_error = None;
                let serial = m.serial;
                reload_playlists(app, serial);
            }
        }
        Item::Playlist(id) => add_to_playlist(app, &id),
        Item::Edit => {
            if let Some(m) = take(app) {
                crate::overlays::edit::open_track(app, &m.track.id);
            }
        }
        Item::Move => {
            if let Some(m) = take(app) {
                crate::overlays::edit::open_move_to_album(app, &m.track);
            }
        }
        Item::Delete | Item::Remove => {
            if let Some(m) = take(app) {
                confirm_delete(app, &m.track, item == Item::Remove);
            }
        }
    }
}

/// Play the selection, or the track from its row's list.
fn play(app: &mut App, m: Menu) {
    match &m.many {
        Some(tracks) => {
            let shuffle = app.player.shuffle;
            track_row::start_list(app, tracks, shuffle);
        }
        None if m.track.unavailable != Some(true) => {
            let queue = if m.ctx.queue.is_empty() { std::slice::from_ref(&m.track) } else { &m.ctx.queue[..] };
            track_row::play_from(app, &m.track, queue);
        }
        None => {}
    }
}

/// Toggle the track's favourite, or the selection's (`favoriteToggleIds`).
fn favorite(app: &mut App, m: Menu) {
    match &m.many {
        None => track_row::toggle_favorite(app, &m.track.id),
        Some(tracks) => {
            let ids: Vec<&str> = tracks.iter().map(|t| t.id.as_str()).collect();
            for id in favorite_toggle_ids(&ids, |id| app.pages.favorites_has(id)) {
                track_row::toggle_favorite(app, &id);
            }
        }
    }
}

/// `runAddToPlaylist`: the track ids in batches, resuming after the batches
/// a failed attempt already landed.
fn add_to_playlist(app: &mut App, playlist: &str) {
    let Some(client) = app.client.clone() else { return };
    let Some(m) = app.overlays.track_menu.menu.as_mut() else { return };
    if m.adding.is_some() {
        return;
    }
    let ids: Vec<String> = m.many.as_ref().map_or_else(|| vec![m.track.id.clone()], |t| t.iter().map(|t| t.id.clone()).collect());
    let ids_key = ids.join("\n");
    let start = m.landed.get(playlist).filter(|(k, _)| *k == ids_key).map_or(0, |(_, n)| *n);
    m.adding = Some(playlist.to_string());
    m.error = None;
    let serial = m.serial;
    let pid = playlist.to_string();
    let batches = add_batches(&ids[start..], PLAYLIST_ADD_BATCH);
    let total = ids.len();
    let id = pid.clone();
    app.net.run(
        move || {
            let mut done = start;
            for batch in batches {
                if let Err(e) = api::playlists::add_playlist_tracks(&client, &id, &batch) {
                    return (done, Some(e));
                }
                done += batch.len();
            }
            (done, None)
        },
        move |app, (done, err)| {
            let Some(m) = menu_for(app, serial) else {
                // An add can finish after the menu closed.
                if done > start {
                    app.load_playlists();
                }
                return;
            };
            m.adding = None;
            m.landed.insert(pid.clone(), (ids_key, done));
            if let Some(e) = err {
                let msg = error_message(&e, "Add failed.");
                m.error = Some(if done > 0 {
                    format!("{msg} {done} of {total} were added; click again to add the rest.")
                } else {
                    msg
                });
            }
            if done == start {
                return;
            }
            m.playlists_changed = true;
            if done == total {
                m.added.insert(pid);
            }
        },
    );
}

/// `runDownload`: the original file into the downloads folder.
fn download(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let Some(m) = app.overlays.track_menu.menu.as_mut() else { return };
    if m.downloading {
        return;
    }
    m.downloading = true;
    m.error = None;
    let serial = m.serial;
    let track = m.track.clone();
    app.net.run(
        move || {
            let (bytes, name) = fetch_download(&client, &track)?;
            crate::core::downloads::save_to_downloads(&name, &bytes).map(|_| ()).map_err(|e| api::ApiError::transport(e.to_string()))
        },
        move |app, result| match result {
            Ok(()) => {
                if menu_for(app, serial).is_some() {
                    close(app);
                }
            }
            Err(e) => {
                if let Some(m) = menu_for(app, serial) {
                    m.error = Some(error_message(&e, "Download failed."));
                    m.downloading = false;
                }
            }
        },
    );
}

/// `prepareTrackDownload` + the stream: the file's bytes and its name
/// ("Artist - Title.ext").
fn fetch_download(client: &Client, t: &TrackListItem) -> api::ApiResult<(Vec<u8>, String)> {
    let prepared = crate::core::audio_format::prepare_track_download(client, t);
    let (bytes, _) = client.bytes(&client.url(&api::media::download_stream_path(&t.id)))?;
    Ok((bytes, prepared.filename))
}

/// `runViewAlbum`: the track's album page (`resolveTrackAlbumTarget`), from
/// the row or else its detail.
fn view_album(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let Some(m) = app.overlays.track_menu.menu.as_mut() else { return };
    if m.viewing_album {
        return;
    }
    m.viewing_album = true;
    m.error = None;
    let serial = m.serial;
    if let Some(target) = track_album_target(&m.track) {
        close(app);
        app.navigate_to(&target.album_href());
        return;
    }
    let t = m.track.clone();
    app.net.run(
        move || resolve_track_album_target_with(&client, &t),
        move |app, result| {
            let Some(m) = menu_for(app, serial) else { return };
            match result {
                Ok(Some(target)) => {
                    close(app);
                    app.navigate_to(&target.album_href());
                }
                Ok(None) => {
                    m.error = Some("No album found for this track.".into());
                    m.viewing_album = false;
                }
                Err(e) => {
                    m.error = Some(error_message(&e, "Album lookup failed."));
                    m.viewing_album = false;
                }
            }
        },
    );
}

/// The two deletes: confirmed, since both are irreversible.
fn confirm_delete(app: &mut App, t: &TrackListItem, global: bool) {
    use crate::overlays::confirm::{self, Art, ConfirmSpec};
    let id = t.id.clone();
    let (title, message, label, busy) = if global {
        ("Remove for everyone?", "This permanently deletes the file from the server, so it leaves every library.", "Remove", "Removing…")
    } else {
        ("Delete from your library?", "This permanently removes the file you uploaded.", "Delete", "Deleting…")
    };
    let spec = ConfirmSpec::new(title, message, label)
        .subject(
            Art::Cover { url: Some(t.cover_at(Some(THUMB))), label: track_row::art_label(t) },
            display_text(Some(&t.title), ""),
            Some(subline(t)),
        )
        .icon(&i::TRASH_2)
        .busy_label(busy)
        .error_fallback("Delete failed.");
    let action = move |client: &Client| {
        if global { api::admin::delete_global_track(client, &id) } else { api::library::delete_track(client, &id) }
    };
    confirm::ask_action(app, spec, action, crate::pages::library_changed);
}
