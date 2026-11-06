//! TIDAL streams: the server answers `/api/tracks/tidal:…/stream` with an
//! HLS playlist (rewritten so every URI goes back through the server),
//! whose fMP4 segments carry FLAC or AAC, possibly AES-128 encrypted. What
//! hls.js did in the web app: pick the best variant, then hand the decoder
//! the init section and the segments in order, fetched ahead on a thread
//! and decrypted. Seeking starts again at the segment holding the target.

use std::collections::HashMap;
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::time::Duration;

use symphonia::core::io::MediaSource;

use super::source::{Http, HttpError};

/// `#EXT-X-KEY`.
#[derive(Clone, Debug, PartialEq)]
pub struct Key {
    pub method: String,
    pub uri: String,
    pub iv: Option<[u8; 16]>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    pub uri: String,
    pub duration: f64,
    /// Index into the playlist's keys; None when unencrypted.
    pub key: Option<usize>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct MediaPlaylist {
    /// `#EXT-X-MAP`: the fMP4 initialization section and its key.
    pub init: Option<(String, Option<usize>)>,
    pub segments: Vec<Segment>,
    pub keys: Vec<Key>,
    pub media_sequence: u64,
}

impl MediaPlaylist {
    pub fn duration(&self) -> f64 {
        self.segments.iter().map(|s| s.duration).sum()
    }

    /// The segment holding `seconds`, and when it starts.
    pub fn segment_at(&self, seconds: f64) -> (usize, f64) {
        let mut start = 0.0;
        for (i, s) in self.segments.iter().enumerate() {
            if seconds < start + s.duration || i + 1 == self.segments.len() {
                return (i, start);
            }
            start += s.duration;
        }
        (0, 0.0)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Playlist {
    /// Variants and their bandwidths.
    Master(Vec<(String, u64)>),
    Media(MediaPlaylist),
}

const MAX_SEGMENTS: usize = 30_000;

/// Parse a playlist, as the backend's `parseHLSPlaylist` does.
pub fn parse(body: &str) -> Result<Playlist, String> {
    let mut media = MediaPlaylist::default();
    let mut variants = Vec::new();
    let mut pending_variant: Option<u64> = None;
    let mut key: Option<usize> = None;
    let mut duration = 0.0;
    let mut is_master = false;
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(tag) = line.strip_prefix('#') {
            if let Some(v) = tag.strip_prefix("EXT-X-MEDIA-SEQUENCE:") {
                media.media_sequence = v.trim().parse().map_err(|_| "HLS media sequence is not a number")?;
            } else if tag.starts_with("EXT-X-STREAM-INF:") {
                is_master = true;
                pending_variant = Some(attributes(line).get("BANDWIDTH").and_then(|b| b.parse().ok()).unwrap_or(0));
            } else if tag.starts_with("EXT-X-KEY:") {
                let attrs = attributes(line);
                let method = attrs.get("METHOD").map(|m| m.trim().to_string()).ok_or("HLS key without a METHOD")?;
                if method.eq_ignore_ascii_case("NONE") {
                    key = None;
                } else {
                    let uri = attrs.get("URI").map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).ok_or("HLS key without a URI")?;
                    let iv = match attrs.get("IV") {
                        Some(v) => Some(parse_iv(v.trim())?),
                        None => None,
                    };
                    media.keys.push(Key { method, uri, iv });
                    key = Some(media.keys.len() - 1);
                }
            } else if tag.starts_with("EXT-X-MAP:") {
                if let Some(uri) = attributes(line).get("URI").filter(|u| !u.is_empty()) {
                    media.init = Some((uri.trim().to_string(), key));
                }
            } else if let Some(v) = tag.strip_prefix("EXTINF:") {
                duration = v.split(',').next().and_then(|d| d.trim().parse().ok()).unwrap_or(0.0);
            }
            continue;
        }
        if let Some(bandwidth) = pending_variant.take() {
            variants.push((line.to_string(), bandwidth));
            continue;
        }
        if media.segments.len() == MAX_SEGMENTS {
            return Err(format!("HLS playlist has more than {MAX_SEGMENTS} segments"));
        }
        media.segments.push(Segment { uri: line.to_string(), duration, key });
        duration = 0.0;
    }
    if is_master { Ok(Playlist::Master(variants)) } else { Ok(Playlist::Media(media)) }
}

fn parse_iv(v: &str) -> Result<[u8; 16], String> {
    let hex = v.strip_prefix("0x").or_else(|| v.strip_prefix("0X")).ok_or("HLS key IV is not hex")?;
    if hex.len() != 32 {
        return Err("HLS key IV is not 128 bits".into());
    }
    let mut iv = [0u8; 16];
    for (i, b) in iv.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|_| "HLS key IV is not hex")?;
    }
    Ok(iv)
}

/// A tag's attribute list: quoted values keep their commas and lose their
/// quotes; the first of a repeated name wins.
fn attributes(line: &str) -> HashMap<String, String> {
    let mut attrs = HashMap::new();
    let Some((_, mut rest)) = line.split_once(':') else { return attrs };
    while !rest.is_empty() {
        let Some((name, after)) = rest.split_once('=') else { break };
        let (value, next) = if let Some(quoted) = after.strip_prefix('"') {
            let (value, tail) = quoted.split_once('"').unwrap_or((quoted, ""));
            (value, tail.split_once(',').map_or("", |(_, t)| t))
        } else {
            after.split_once(',').unwrap_or((after, ""))
        };
        attrs.entry(name.trim().to_string()).or_insert_with(|| value.to_string());
        rest = next;
    }
    attrs
}

/// Resolve a playlist URI against the playlist's URL.
pub fn resolve(base: &str, uri: &str) -> String {
    if uri.starts_with("http://") || uri.starts_with("https://") {
        return uri.to_string();
    }
    let scheme_end = base.find("://").map_or(0, |i| i + 3);
    let origin_end = base[scheme_end..].find('/').map_or(base.len(), |i| scheme_end + i);
    if uri.starts_with("//") {
        return format!("{}{}", &base[..scheme_end.saturating_sub(2)], uri);
    }
    if uri.starts_with('/') {
        return format!("{}{}", &base[..origin_end], uri);
    }
    let path = base.split(['?', '#']).next().unwrap_or(base);
    let dir_end = path.rfind('/').filter(|&i| i >= origin_end).map_or(path.len(), |i| i + 1);
    let dir = &path[..dir_end];
    if dir.ends_with('/') { format!("{dir}{uri}") } else { format!("{dir}/{uri}") }
}

/// AES-128-CBC with the HLS default IV (the media sequence number) when
/// the key gives none, and PKCS7 padding removed when it's valid.
pub fn decrypt(data: &[u8], key: &[u8; 16], iv: Option<[u8; 16]>, sequence: u64) -> Result<Vec<u8>, String> {
    use aes::cipher::{BlockDecryptMut, KeyIvInit, block_padding::NoPadding};
    if !data.len().is_multiple_of(16) {
        return Err(format!("encrypted segment of {} bytes isn't whole blocks", data.len()));
    }
    let iv = iv.unwrap_or_else(|| {
        let mut iv = [0u8; 16];
        iv[8..].copy_from_slice(&sequence.to_be_bytes());
        iv
    });
    let mut out = cbc::Decryptor::<aes::Aes128>::new(key.into(), &iv.into())
        .decrypt_padded_vec_mut::<NoPadding>(data)
        .map_err(|e| format!("AES: {e}"))?;
    if let Some(&pad) = out.last() {
        let pad = pad as usize;
        if (1..=16).contains(&pad) && pad <= out.len() && out[out.len() - pad..].iter().all(|&b| b as usize == pad) {
            out.truncate(out.len() - pad);
        }
    }
    Ok(out)
}

/// A TIDAL stream: its media playlist, its URL, and the keys fetched so far.
#[derive(Clone)]
pub struct HlsStream {
    pub url: String,
    pub playlist: Arc<MediaPlaylist>,
    http: Http,
    keys: Arc<std::sync::Mutex<HashMap<String, [u8; 16]>>>,
}

impl HlsStream {
    /// From the playlist at `url` (already fetched as `body`): descend into
    /// the best variant of a master playlist.
    pub fn open(http: Http, url: &str, body: &str) -> Result<HlsStream, String> {
        let mut url = url.to_string();
        let mut parsed = parse(body)?;
        if let Playlist::Master(variants) = &parsed {
            let best = variants.iter().max_by_key(|v| v.1).ok_or("HLS master playlist has no variants")?;
            url = resolve(&url, &best.0);
            let (body, _) = http.get_bytes(&url, 4 << 20).map_err(|e| format!("HLS playlist: {e}"))?;
            parsed = parse(&String::from_utf8_lossy(&body))?;
        }
        let Playlist::Media(playlist) = parsed else { return Err("HLS variant is itself a master playlist".into()) };
        if playlist.segments.is_empty() {
            return Err("HLS playlist has no segments".into());
        }
        for key in &playlist.keys {
            if !key.method.eq_ignore_ascii_case("AES-128") {
                return Err(format!("HLS key method {} isn't supported", key.method));
            }
        }
        Ok(HlsStream { url, playlist: Arc::new(playlist), http, keys: Default::default() })
    }

    fn key(&self, index: usize) -> Result<[u8; 16], HttpError> {
        let key = &self.playlist.keys[index];
        let uri = resolve(&self.url, &key.uri);
        if let Some(k) = self.keys.lock().unwrap().get(&uri) {
            return Ok(*k);
        }
        let (bytes, _) = self.http.get_bytes(&uri, 64)?;
        let k: [u8; 16] = bytes.as_slice().try_into().map_err(|_| HttpError { status: 0, message: format!("HLS key has {} bytes", bytes.len()) })?;
        self.keys.lock().unwrap().insert(uri, k);
        Ok(k)
    }

    /// One segment (or the init section, `None`), fetched and decrypted.
    fn fetch(&self, index: Option<usize>) -> Result<Vec<u8>, String> {
        let (uri, key, sequence) = match index {
            None => {
                let (uri, key) = self.playlist.init.clone().ok_or("no init section")?;
                (uri, key, 0)
            }
            Some(i) => {
                let s = &self.playlist.segments[i];
                (s.uri.clone(), s.key, self.playlist.media_sequence + i as u64)
            }
        };
        let url = resolve(&self.url, &uri);
        let what = if index.is_none() { "HLS init section".to_string() } else { format!("HLS segment {}", index.unwrap_or(0) + 1) };
        let mut attempt = 0;
        let body = loop {
            match self.http.get_bytes(&url, 64 << 20) {
                Ok((body, _)) => break body,
                // A refused segment (an expired address, say) won't load again.
                Err(e) if (400..500).contains(&e.status) || attempt == 2 => return Err(format!("{what}: {e}")),
                Err(_) => {
                    attempt += 1;
                    std::thread::sleep(Duration::from_millis(500 * attempt));
                }
            }
        };
        match key {
            None => Ok(body),
            Some(k) => {
                let iv = self.playlist.keys[k].iv;
                let key = self.key(k).map_err(|e| format!("HLS key: {e}"))?;
                decrypt(&body, &key, iv, sequence).map_err(|e| format!("{what}: {e}"))
            }
        }
    }

    /// A reader over the init section and the segments from `first` on,
    /// fetched ahead on a thread.
    pub fn reader(&self, first: usize, cancel: Arc<AtomicBool>) -> HlsReader {
        // About 20 s ahead (TIDAL cuts segments of ~4 s), as hls.js buffers.
        let (tx, rx) = sync_channel::<Result<Vec<u8>, String>>(4);
        let stream = self.clone();
        let stop = cancel.clone();
        let _ = std::thread::Builder::new().name("lumen-hls".into()).spawn(move || {
            let send = |chunk: Result<Vec<u8>, String>, tx: &SyncSender<Result<Vec<u8>, String>>| tx.send(chunk).is_ok();
            if stream.playlist.init.is_some() && !send(stream.fetch(None), &tx) {
                return;
            }
            for i in first..stream.playlist.segments.len() {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let chunk = stream.fetch(Some(i));
                let failed = chunk.is_err();
                if !send(chunk, &tx) || failed {
                    return;
                }
            }
        });
        HlsReader { rx: std::sync::Mutex::new(rx), chunk: Vec::new(), at: 0, pos: 0, done: false }
    }
}

/// The bytes of an HLS stream from a segment on, in order. Seeks only
/// within what's buffered (symphonia reads fMP4 forward).
pub struct HlsReader {
    rx: std::sync::Mutex<Receiver<Result<Vec<u8>, String>>>,
    chunk: Vec<u8>,
    at: usize,
    pos: u64,
    done: bool,
}

impl Read for HlsReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        while self.at >= self.chunk.len() {
            if self.done {
                return Ok(0);
            }
            let next = self.rx.get_mut().unwrap_or_else(|e| e.into_inner()).recv();
            match next {
                Ok(Ok(chunk)) => {
                    self.chunk = chunk;
                    self.at = 0;
                }
                Ok(Err(e)) => {
                    self.done = true;
                    return Err(io::Error::other(e));
                }
                Err(_) => {
                    self.done = true;
                    return Ok(0);
                }
            }
        }
        let n = buf.len().min(self.chunk.len() - self.at);
        buf[..n].copy_from_slice(&self.chunk[self.at..self.at + n]);
        self.at += n;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HlsReader {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let target = match to {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::Current(d) => self.pos as i64 + d,
            SeekFrom::End(_) => return Err(io::Error::new(io::ErrorKind::Unsupported, "unknown length")),
        };
        let back = self.pos as i64 - target;
        if back >= 0 && back as usize <= self.at {
            self.at -= back as usize;
            self.pos = target as u64;
            return Ok(self.pos);
        }
        if target > self.pos as i64 {
            let skip = target as u64 - self.pos;
            io::copy(&mut self.take(skip), &mut io::sink())?;
            return Ok(self.pos);
        }
        Err(io::Error::new(io::ErrorKind::Unsupported, "HLS streams read forward"))
    }
}

impl MediaSource for HlsReader {
    fn is_seekable(&self) -> bool {
        false
    }
    fn byte_len(&self) -> Option<u64> {
        None
    }
}

/// Whether to treat `url` (or what it answered) as HLS: `shouldUseHLS`,
/// plus the answer's type, so a library row backed by TIDAL plays too.
pub fn is_hls(url: &str, content_type: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let ty = content_type.to_ascii_lowercase();
    lower.contains("/api/tracks/tidal%3a") || lower.contains(".m3u8") || ty.contains("mpegurl")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_media_playlists_with_keys_and_a_map() {
        let body = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA-SEQUENCE:5\n\
            #EXT-X-KEY:METHOD=AES-128,URI=\"/api/tracks/tidal%3A1/hls?u=k,1\",IV=0x000102030405060708090a0b0c0d0e0f\n\
            #EXT-X-MAP:URI=\"/api/tracks/tidal%3A1/hls?u=init\"\n\
            #EXTINF:4.0,\n/api/tracks/tidal%3A1/hls?u=s1\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2.5,\n/api/tracks/tidal%3A1/hls?u=s2\n#EXT-X-ENDLIST\n";
        let Playlist::Media(p) = parse(body).unwrap() else { panic!() };
        assert_eq!(p.media_sequence, 5);
        assert_eq!(p.keys.len(), 1);
        assert_eq!(p.keys[0].uri, "/api/tracks/tidal%3A1/hls?u=k,1");
        assert_eq!(p.keys[0].iv.unwrap()[15], 0x0f);
        assert_eq!(p.init, Some(("/api/tracks/tidal%3A1/hls?u=init".into(), Some(0))));
        assert_eq!(p.segments.len(), 2);
        assert_eq!((p.segments[0].key, p.segments[1].key), (Some(0), None));
        assert_eq!(p.duration(), 6.5);
        assert_eq!(p.segment_at(0.0), (0, 0.0));
        assert_eq!(p.segment_at(4.2), (1, 4.0));
        assert_eq!(p.segment_at(99.0), (1, 4.0));
    }

    #[test]
    fn parses_master_playlists() {
        let body = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=320000,CODECS=\"mp4a.40.2\"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1411000,CODECS=\"flac\"\nhigh.m3u8\n";
        assert_eq!(parse(body).unwrap(), Playlist::Master(vec![("low.m3u8".into(), 320_000), ("high.m3u8".into(), 1_411_000)]));
        assert!(parse("#EXT-X-KEY:METHOD=AES-128\nseg").is_err());
        assert!(parse("#EXT-X-KEY:METHOD=AES-128,URI=\"k\",IV=0x12\nseg").is_err());
    }

    #[test]
    fn resolves_uris_against_the_playlist() {
        let base = "https://music.example/api/tracks/tidal%3A1/stream?x=1";
        assert_eq!(resolve(base, "/api/tracks/tidal%3A1/hls?u=a"), "https://music.example/api/tracks/tidal%3A1/hls?u=a");
        assert_eq!(resolve(base, "seg1.mp4"), "https://music.example/api/tracks/tidal%3A1/seg1.mp4");
        assert_eq!(resolve(base, "https://cdn/x"), "https://cdn/x");
        assert_eq!(resolve("http://h:1/a/b/list.m3u8", "//cdn/x"), "http://cdn/x");
        assert_eq!(resolve("http://h:1", "x"), "http://h:1/x");
    }

    #[test]
    fn decrypts_aes_128_cbc_with_the_sequence_iv() {
        use aes::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
        let key = [7u8; 16];
        let plain = b"moof and mdat bytes, thirty-eight long".to_vec();
        let mut iv = [0u8; 16];
        iv[8..].copy_from_slice(&42u64.to_be_bytes());
        let ct = cbc::Encryptor::<aes::Aes128>::new(&key.into(), &iv.into()).encrypt_padded_vec_mut::<Pkcs7>(&plain);
        assert_eq!(decrypt(&ct, &key, None, 42).unwrap(), plain);
        assert_ne!(decrypt(&ct, &key, None, 41).unwrap(), plain);
        assert_eq!(decrypt(&ct, &key, Some(iv), 0).unwrap(), plain);
        assert!(decrypt(&ct[..5], &key, None, 42).is_err());
    }

    #[test]
    fn knows_hls_by_address_or_type() {
        assert!(is_hls("http://h/api/tracks/tidal%3A12/stream", ""));
        assert!(is_hls("http://h/api/tracks/abc/stream", "application/vnd.apple.mpegurl"));
        assert!(!is_hls("http://h/api/tracks/abc/stream", "audio/flac"));
    }
}
