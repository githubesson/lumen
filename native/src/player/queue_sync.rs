//! `core/src/player/queue-sync.ts`: the bounded window of the play order a
//! device publishes with its activity, so others can show and jump in it.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::api::{TrackListItem, TrackSource};

use super::core::Repeat;

/// Must match `playbackSocketReadLimit` in the backend's `activity.go`.
pub const PLAYBACK_SOCKET_MAX_BYTES: usize = 64 * 1024;

/// `PlaybackQueueSnapshot`: indices in commands are absolute.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueueSnapshot {
    pub revision: String,
    #[serde(default)]
    pub tracks: Vec<TrackListItem>,
    #[serde(default)]
    pub index: usize,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub shuffle: bool,
    #[serde(default = "off")]
    pub repeat: String,
}

fn off() -> String {
    "off".into()
}

impl QueueSnapshot {
    pub fn repeat(&self) -> Repeat {
        Repeat::parse(&self.repeat).unwrap_or_default()
    }
}

/// `compactRemoteTrack`: the fields another device needs (and the server's
/// strict decoder accepts), without empty ones.
pub fn compact_track(t: &TrackListItem) -> Value {
    let mut m = Map::new();
    let mut put = |k: &str, v: Value| {
        m.insert(k.into(), v);
    };
    put("id", json!(t.id));
    let opt = |v: &Option<String>| v.as_ref().map(|s| json!(s));
    if let Some(v) = opt(&t.db_track_id) {
        put("db_track_id", v);
    }
    // A source this client doesn't know isn't echoed back.
    match t.source {
        Some(TrackSource::Local) => put("source", json!("local")),
        Some(TrackSource::Tidal) => put("source", json!("tidal")),
        Some(TrackSource::Other) | None => {}
    }
    for (k, v) in [("source_id", &t.source_id), ("source_album_id", &t.source_album_id)] {
        if let Some(v) = opt(v) {
            put(k, v);
        }
    }
    put("title", json!(t.title));
    for (k, v) in [("album_id", &t.album_id), ("album_title", &t.album_title)] {
        if let Some(v) = opt(v) {
            put(k, v);
        }
    }
    if let Some(n) = t.track_no {
        put("track_no", json!(n));
    }
    put("duration_ms", json!(t.duration_ms));
    for (k, v) in [("artist", &t.artist), ("aka", &t.aka)] {
        if let Some(v) = opt(v) {
            put(k, v);
        }
    }
    for (k, v) in [("favorited", t.favorited), ("has_cover", t.has_cover)] {
        if let Some(v) = v {
            put(k, json!(v));
        }
    }
    if let Some(v) = opt(&t.cover_url) {
        put("cover_url", v);
    }
    if let Some(v) = t.owned {
        put("owned", json!(v));
    }
    Value::Object(m)
}

/// The tracks a device shares of its play order (the queue snapshot, or the
/// queue a `play_track` command sends): at most 50 around entry `index` of
/// `len`, 24 before it where there are enough after.
pub fn queue_window(index: usize, len: usize) -> std::ops::Range<usize> {
    let start = (index as i64 - 24).min(len as i64 - 50).max(0) as usize;
    start..(start + 50).min(len)
}

/// `buildPlaybackQueueSnapshot`: a contiguous window of at most 50 tracks
/// holding the current one, trimmed from its farther edge to fit
/// `max_bytes`. None when even the current track alone can't fit.
pub fn build_snapshot(
    queue: &[TrackListItem],
    index: usize,
    shuffle: bool,
    repeat: Repeat,
    revision: &str,
    max_bytes: usize,
) -> Option<Value> {
    let len = queue.len();
    let window = queue_window(index, len);
    let mut offset = window.start;
    let mut tracks: Vec<Value> = queue[window].iter().map(compact_track).collect();
    let mut rel = if len > 0 { index - offset } else { 0 };
    let mut sizes: Vec<usize> = tracks.iter().map(|t| t.to_string().len()).collect();
    let envelope = |tracks: usize, offset: usize, rel: usize| {
        json!({ "revision": revision, "tracks": [], "index": rel, "offset": offset, "total": len, "shuffle": shuffle, "repeat": repeat.as_str() })
            .to_string()
            .len()
            + tracks.saturating_sub(1)
    };
    let fits = |sizes: &[usize], offset: usize, rel: usize| envelope(sizes.len(), offset, rel) + sizes.iter().sum::<usize>() <= max_bytes;
    while !fits(&sizes, offset, rel) && tracks.len() > 1 {
        // Drop the farther edge so the current entry stays in the window.
        if rel > tracks.len() - rel - 1 {
            tracks.remove(0);
            sizes.remove(0);
            rel -= 1;
            offset += 1;
        } else {
            tracks.pop();
            sizes.pop();
        }
    }
    if !fits(&sizes, offset, rel) && tracks.len() == 1 {
        // A single track's optional fields can exceed the budget by themselves.
        let t = &tracks[0];
        tracks[0] = json!({ "id": t["id"], "title": t["title"], "duration_ms": t["duration_ms"] });
        sizes[0] = tracks[0].to_string().len();
    }
    fits(&sizes, offset, rel).then(|| {
        json!({ "revision": revision, "tracks": tracks, "index": rel, "offset": offset, "total": len, "shuffle": shuffle, "repeat": repeat.as_str() })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player::core::track;

    fn queue(n: usize) -> Vec<TrackListItem> {
        (0..n).map(|i| track(&format!("t{i}"))).collect()
    }

    #[test]
    fn windows_fifty_tracks_around_the_current_one() {
        let q = queue(200);
        let s = build_snapshot(&q, 100, true, Repeat::All, "r1", 60 * 1024).unwrap();
        assert_eq!(s["offset"], 76);
        assert_eq!(s["index"], 24);
        assert_eq!(s["total"], 200);
        assert_eq!(s["tracks"].as_array().unwrap().len(), 50);
        assert_eq!(s["tracks"][24]["id"], "t100");
        assert_eq!(s["repeat"], "all");
        let s = build_snapshot(&q, 3, false, Repeat::Off, "r1", 60 * 1024).unwrap();
        assert_eq!((s["offset"].as_u64(), s["index"].as_u64()), (Some(0), Some(3)));
        let s = build_snapshot(&q, 199, false, Repeat::Off, "r1", 60 * 1024).unwrap();
        assert_eq!((s["offset"].as_u64(), s["index"].as_u64()), (Some(150), Some(49)));
        let empty = build_snapshot(&[], 0, false, Repeat::Off, "r", 1024).unwrap();
        assert_eq!(empty["tracks"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn trims_to_the_budget_keeping_the_current_track() {
        let q = queue(50);
        let s = build_snapshot(&q, 40, false, Repeat::Off, "r", 2000).unwrap();
        let tracks = s["tracks"].as_array().unwrap();
        assert!(s.to_string().len() <= 2000);
        let at = s["index"].as_u64().unwrap() as usize;
        assert_eq!(tracks[at]["id"], "t40");
        assert_eq!(s["offset"].as_u64().unwrap() as usize + at, 40);
        // A lone track with heavy metadata is cut down to its essentials.
        let mut big = track("big");
        big.album_title = Some("x".repeat(5000));
        let s = build_snapshot(&[big], 0, false, Repeat::Off, "r", 600).unwrap();
        assert_eq!(s["tracks"][0].as_object().unwrap().len(), 3);
        assert!(build_snapshot(&queue(1), 0, false, Repeat::Off, "r", 10).is_none());
    }

    #[test]
    fn compact_tracks_carry_only_known_fields() {
        let mut t = track("a");
        t.source = Some(TrackSource::Tidal);
        t.unavailable = Some(false);
        t.track_no = Some(3);
        let v = compact_track(&t);
        assert_eq!(v["source"], "tidal");
        assert_eq!(v["track_no"], 3);
        assert!(v.get("unavailable").is_none() && v.get("artist").is_none());
    }
}
