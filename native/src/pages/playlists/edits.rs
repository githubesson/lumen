//! The playlist page's track edits (`commitTracks` in `PlaylistDetail.tsx`):
//! remove and reorder show at once and run one at a time, each against the
//! rows the edit before it left.

use std::collections::{HashMap, VecDeque};

use crate::api::{ApiResult, Client, PlaylistTrackEntry};
use crate::app::App;

use super::detail::{Download, arm_poll, cover_for, current, detail, detail_mut, invalidate_loads, load, write_cache};
use super::logic::{self, error_message};
use super::{requests, update_playlists};

/// Counters for one visit's track edits (`pendingTrackMutationsRef`, …).
#[derive(Default)]
struct Counters {
    pending: u32,
    epoch: u64,
    error: Option<String>,
    /// The load generation the newest edit left.
    seq: u64,
}

/// An edit's request, run on a worker.
type Request = Box<dyn FnOnce(&Client) -> ApiResult<()> + Send>;

struct Job {
    mount: u64,
    id: String,
    epoch: u64,
    fallback: &'static str,
    next: Vec<PlaylistTrackEntry>,
    run: Request,
}

/// Track edits (remove, reorder) run one at a time: each one's positions
/// refer to the rows the edit before it left. Still sent after navigating
/// away: the edit was the user's intent.
#[derive(Default)]
pub struct Mutations {
    jobs: VecDeque<Job>,
    running: bool,
    by_mount: HashMap<u64, Counters>,
}


/// Show `next` at once and queue `run`; if an edit fails, the ones queued
/// behind it (computed from rows that no longer match) are dropped and the
/// page reloads once the queue drains.
/// How many edits the visit `mount` has queued or running.
pub(super) fn pending(app: &App, mount: u64) -> u32 {
    app.pages.playlists.mutations.by_mount.get(&mount).map_or(0, |c| c.pending)
}

fn commit_tracks(
    app: &mut App,
    next: Vec<PlaylistTrackEntry>,
    fallback: &'static str,
    run: impl FnOnce(&Client) -> ApiResult<()> + Send + 'static,
) {
    invalidate_loads(app);
    let Some(d) = detail_mut(app) else { return };
    d.tracks = Some(next.clone());
    let (mount, id, seq) = (d.mount, d.id.clone(), d.load_gen);
    let m = &mut app.pages.playlists.mutations;
    let c = m.by_mount.entry(mount).or_default();
    c.pending += 1;
    c.seq = seq;
    let epoch = c.epoch;
    m.jobs.push_back(Job { mount, id, epoch, fallback, next, run: Box::new(run) });
    write_cache(app);
    pump(app);
}

fn pump(app: &mut App) {
    let m = &mut app.pages.playlists.mutations;
    if m.running {
        return;
    }
    let Some(job) = m.jobs.pop_front() else { return };
    let c = m.by_mount.entry(job.mount).or_default();
    if job.epoch != c.epoch || c.error.is_some() {
        c.error.get_or_insert_with(|| job.fallback.to_string());
        finish(app, job.mount, job.id, job.next);
        return;
    }
    let Some(client) = app.client.clone() else { return };
    m.running = true;
    let Job { mount, id, fallback, next, run, .. } = job;
    app.net.run(
        move || run(&client),
        move |app, result| {
            let m = &mut app.pages.playlists.mutations;
            m.running = false;
            if let Err(e) = result {
                let c = m.by_mount.entry(mount).or_default();
                c.epoch += 1;
                c.error = Some(error_message(&e, fallback));
            }
            finish(app, mount, id, next);
        },
    );
}

fn finish(app: &mut App, mount: u64, id: String, next: Vec<PlaylistTrackEntry>) {
    let m = &mut app.pages.playlists.mutations;
    let c = m.by_mount.entry(mount).or_default();
    c.pending = c.pending.saturating_sub(1);
    if c.pending > 0 {
        pump(app);
        return;
    }
    let failure = c.error.take();
    let edit_gen = c.seq;
    if current(app, mount).is_none() {
        // Left the page: its cache holds the optimistic rows. After a
        // failure, drop it so a revisit doesn't paint an edit that failed.
        if failure.is_some() {
            app.pages.playlists.cache.remove(&id);
        }
        app.pages.playlists.mutations.by_mount.remove(&mount);
        pump(app);
        return;
    }
    if let Some(message) = failure {
        load(
            app,
            Some(Box::new(move |app: &mut App| {
                // Edits made while this reload was out still saw the failed rows.
                if let Some(c) = app.pages.playlists.mutations.by_mount.get_mut(&mount) {
                    c.epoch += 1;
                }
                if let Some(d) = current(app, mount) {
                    d.error = Some(message);
                }
            })),
        );
        pump(app);
        return;
    }
    let d = detail(app).unwrap();
    if d.load_gen != edit_gen || !d.full_load_done {
        // A details action reloaded while edits were pending, or an edit
        // overtook the first load: read everything again.
        load(app, None);
        pump(app);
        return;
    }
    let seq = d.load_gen;
    if let Some(client) = app.client.clone() {
        let read_id = id.clone();
        app.net.run(
            move || requests::list_playlist_tracks_if_changed(&client, &read_id, None),
            move |app, result| {
                let busy = pending(app, mount) > 0;
                let Some(d) = current(app, mount) else { return };
                let Ok(fresh) = result else { return };
                if seq != d.load_gen || busy {
                    return;
                }
                d.etag = fresh.etag;
                let rows = fresh.data.as_ref().map_or(next, |x| x.tracks.clone());
                if let Some(x) = &fresh.data {
                    d.download = Some(Download { queued: x.tidal_queued, retry_at: x.tidal_retry_at.clone() });
                }
                d.tracks = Some(rows.clone());
                d.error = None;
                let cover = cover_for(&rows);
                update_playlists(app, |list| {
                    if let Some(r) = list.iter_mut().find(|r| r.id == id) {
                        r.cover = cover;
                    }
                });
                write_cache(app);
                arm_poll(app);
            },
        );
    }
    pump(app);
}

/// Remove the row at `position`.
pub fn remove(app: &mut App, position: u32) {
    let Some(d) = detail(app) else { return };
    let Some(rows) = &d.tracks else { return };
    let next = logic::remove_entry(rows, position);
    let id = d.id.clone();
    commit_tracks(app, next, "Failed to remove track.", move |c| requests::remove_playlist_track(c, &id, position));
}

/// Move the row at index `from` to index `to` (only offered against the
/// saved order with nothing filtered out).
pub fn reorder(app: &mut App, from: usize, to: usize) {
    let Some(d) = detail(app) else { return };
    let Some(rows) = &d.tracks else { return };
    if from == to {
        return;
    }
    let next = logic::move_entry(rows, from, to);
    let ids: Vec<String> = next.iter().map(|t| t.track_id.clone()).collect();
    let id = d.id.clone();
    commit_tracks(app, next, "Failed to reorder tracks.", move |c| requests::reorder_playlist(c, &id, &ids));
}
