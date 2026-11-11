//! Multipart uploads: music files (`uploadMusic`) and cover images
//! (`setAlbumCover`, `setPlaylistCover`), streamed from disk with progress.
//! Choosing scope, batching and reading results is `core::upload`.
//!
//! Like every form upload on the web, these have no deadline.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use super::client::{ApiError, ApiResult, Behavior, Body, Client, Progress, seg};
use super::types::{Album, Playlist, UploadResult};

/// One field of a form.
pub enum Part {
    Text { name: String, value: String },
    File { name: String, filename: String, content_type: String, source: FileSource },
}

/// Where a file part's bytes come from.
pub enum FileSource {
    Path(PathBuf),
    #[cfg(test)]
    Bytes(Vec<u8>),
}

impl Part {
    pub fn text(name: &str, value: impl Into<String>) -> Part {
        Part::Text { name: name.to_string(), value: value.into() }
    }

    /// A file on disk, named and typed after it (as a browser `File` is).
    pub fn file(name: &str, path: &Path) -> Part {
        let filename = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        Part::File {
            name: name.to_string(),
            content_type: content_type_for(&filename).to_string(),
            filename,
            source: FileSource::Path(path.to_path_buf()),
        }
    }

    /// Bytes in memory under a file name.
    #[cfg(test)]
    pub fn bytes(name: &str, filename: &str, bytes: Vec<u8>) -> Part {
        Part::File {
            name: name.to_string(),
            content_type: content_type_for(filename).to_string(),
            filename: filename.to_string(),
            source: FileSource::Bytes(bytes),
        }
    }
}

/// The type a browser gives a file by its extension.
pub fn content_type_for(filename: &str) -> &'static str {
    let ext = filename.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "m4a" => "audio/x-m4a",
        "mp4" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        "webm" => "audio/webm",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "heic" => "image/heic",
        _ => "application/octet-stream",
    }
}

/// A `multipart/form-data` body.
pub struct Multipart {
    pub boundary: String,
    pub parts: Vec<Part>,
}

/// Quote a name the way browsers do in `Content-Disposition`.
fn quoted(s: &str) -> String {
    s.replace('"', "%22").replace('\r', "%0D").replace('\n', "%0A")
}

enum Segment {
    Bytes(Vec<u8>),
    File(PathBuf, u64),
}

impl Multipart {
    pub fn new(parts: Vec<Part>) -> Multipart {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        Multipart { boundary: format!("----LumenFormBoundary{n:x}"), parts }
    }

    fn segments(self) -> io::Result<(String, Vec<Segment>)> {
        let mut segs = Vec::new();
        let b = &self.boundary;
        for part in self.parts {
            match part {
                Part::Text { name, value } => segs.push(Segment::Bytes(
                    format!("--{b}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{value}\r\n", quoted(&name))
                        .into_bytes(),
                )),
                Part::File { name, filename, content_type, source } => {
                    segs.push(Segment::Bytes(
                        format!(
                            "--{b}\r\nContent-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {content_type}\r\n\r\n",
                            quoted(&name),
                            quoted(&filename)
                        )
                        .into_bytes(),
                    ));
                    match source {
                        #[cfg(test)]
                        FileSource::Bytes(bytes) => segs.push(Segment::Bytes(bytes)),
                        FileSource::Path(path) => {
                            let len = std::fs::metadata(&path)?.len();
                            segs.push(Segment::File(path, len));
                        }
                    }
                    segs.push(Segment::Bytes(b"\r\n".to_vec()));
                }
            }
        }
        segs.push(Segment::Bytes(format!("--{b}--\r\n").into_bytes()));
        Ok((self.boundary, segs))
    }

    /// The whole body in memory (tests).
    #[cfg(test)]
    pub fn to_bytes(self) -> io::Result<(String, Vec<u8>)> {
        let (boundary, segs) = self.segments()?;
        let mut out = Vec::new();
        for s in segs {
            match s {
                Segment::Bytes(b) => out.extend(b),
                Segment::File(p, _) => {
                    File::open(p)?.read_to_end(&mut out)?;
                }
            }
        }
        Ok((boundary, out))
    }

    /// A streamed body that reports `(sent, total)` as it goes. Fails when
    /// a file can't be read for its size.
    pub fn into_body(self, progress: Option<Progress>) -> io::Result<Body> {
        let (boundary, segs) = self.segments()?;
        let len = segs
            .iter()
            .map(|s| match s {
                Segment::Bytes(b) => b.len() as u64,
                Segment::File(_, n) => *n,
            })
            .sum();
        let reader = SegmentReader { segs: segs.into(), current: None, sent: 0, total: len, progress };
        Ok(Body::Stream {
            content_type: format!("multipart/form-data; boundary={boundary}"),
            len,
            reader: Box::new(reader),
        })
    }
}

struct SegmentReader {
    segs: std::collections::VecDeque<Segment>,
    current: Option<Box<dyn Read + Send>>,
    sent: u64,
    total: u64,
    progress: Option<Progress>,
}

impl Read for SegmentReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if self.current.is_none() {
                match self.segs.pop_front() {
                    None => return Ok(0),
                    Some(Segment::Bytes(b)) => self.current = Some(Box::new(io::Cursor::new(b))),
                    Some(Segment::File(p, len)) => self.current = Some(Box::new(File::open(p)?.take(len))),
                }
            }
            let n = self.current.as_mut().map_or(Ok(0), |r| r.read(buf))?;
            if n == 0 {
                self.current = None;
                continue;
            }
            self.sent += n as u64;
            if let Some(p) = &self.progress {
                p(self.sent, self.total);
            }
            return Ok(n);
        }
    }
}

fn send_form<T: serde::de::DeserializeOwned>(
    c: &Client,
    method: &str,
    path: &str,
    form: Multipart,
    progress: Option<Progress>,
) -> ApiResult<T> {
    let body = form.into_body(progress).map_err(|e| ApiError::local(0, e.to_string()))?;
    c.request(method, path, body, &[], &Behavior { timeout: None, ..Default::default() })?.json()
}

/// `uploadMusic`: files into the personal or shared library (see
/// `core::upload::plan_upload_batches` for staying under the server's cap).
pub fn upload_music(
    c: &Client,
    files: &[PathBuf],
    scope: crate::core::upload::UploadScope,
    progress: Option<Progress>,
) -> ApiResult<Vec<UploadResult>> {
    let mut parts = vec![Part::text("scope", scope.as_str())];
    parts.extend(files.iter().map(|f| Part::file("files", f)));
    let results: Option<Vec<UploadResult>> = send_form(c, "POST", "/api/library/upload", Multipart::new(parts), progress)?;
    Ok(results.unwrap_or_default())
}

/// Upload with cancellation checked before every body read. Completed responses
/// still return their track IDs so the caller can undo only this operation's inserts.
pub fn upload_music_cancellable(
    c: &Client,
    files: &[PathBuf],
    scope: crate::core::upload::UploadScope,
    cancel: &super::Cancel,
) -> ApiResult<Vec<UploadResult>> {
    cancel.check()?;
    let mut parts = vec![Part::text("scope", scope.as_str())];
    parts.extend(files.iter().map(|f| Part::file("files", f)));
    let body = Multipart::new(parts).into_body(None).map_err(|e| ApiError::local(0, e.to_string()))?;
    let body = match body {
        Body::Stream { content_type, len, reader } => Body::Stream {
            content_type, len, reader: Box::new(CancellableReader { reader, cancel: cancel.clone() }),
        },
        body => body,
    };
    let reply = c.request("POST", "/api/library/upload", body, &[], &Behavior { timeout: None, ..Default::default() });
    match reply {
        Ok(reply) => {
            let results: Option<Vec<UploadResult>> = reply.json()?;
            Ok(results.unwrap_or_default())
        }
        Err(_) if cancel.is_cancelled() => Err(ApiError::aborted()),
        Err(e) => Err(e),
    }
}

struct CancellableReader {
    reader: Box<dyn Read + Send>,
    cancel: super::Cancel,
}

impl Read for CancellableReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cancel.is_cancelled() {
            // Interrupted is retried by Read helpers; use a terminal error instead.
            return Err(io::Error::other("Upload cancelled"));
        }
        self.reader.read(buf)
    }
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;
    #[test]
    fn cancelling_stops_consumption_of_the_upload_body() {
        let cancel = super::super::Cancel::new();
        let mut reader = CancellableReader { reader: Box::new(io::Cursor::new(vec![1, 2, 3, 4])), cancel: cancel.clone() };
        let mut bytes = [0; 2];
        assert_eq!(reader.read(&mut bytes).unwrap(), 2);
        cancel.cancel();
        assert!(reader.read(&mut bytes).is_err());
    }
}

/// Admin: replace an album's cover with an image file.
pub fn set_album_cover(c: &Client, id: &str, image: &Path) -> ApiResult<Album> {
    send_form(c, "PUT", &format!("/api/albums/{}/cover", seg(id)), Multipart::new(vec![Part::file("file", image)]), None)
}

/// Owner: give a playlist its own cover (see
/// `core::playlist_details::playlist_cover_size_error` first).
pub fn set_playlist_cover(c: &Client, id: &str, image: &Path) -> ApiResult<Playlist> {
    send_form(c, "PUT", &format!("/api/playlists/{}/cover", seg(id)), Multipart::new(vec![Part::file("file", image)]), None)
}

/// A progress callback from a closure.
#[cfg(test)]
pub fn progress(f: impl Fn(u64, u64) + Send + Sync + 'static) -> Progress {
    std::sync::Arc::new(f)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::client::error_message;
    use crate::api::testing::{MockServer, Res};
    use std::sync::{Arc, Mutex};

    fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = crate::api::testing::temp_path("upload");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn streams_files_with_progress() {
        let server = MockServer::start(vec![Res::json(r#"[{"file":"a.mp3","inserted":true}]"#)]);
        let path = temp_file("a.mp3", b"ID3audio");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        let results = upload_music(
            &server.client(),
            &[path],
            crate::core::upload::UploadScope::Personal,
            Some(progress(move |sent, total| s2.lock().unwrap().push((sent, total)))),
        )
        .unwrap();
        assert!(results[0].inserted);
        let req = &server.requests()[0];
        assert_eq!((req.method.as_str(), req.path.as_str()), ("POST", "/api/library/upload"));
        let ct = req.header("content-type").unwrap();
        let boundary = ct.strip_prefix("multipart/form-data; boundary=").unwrap();
        let body = req.text();
        assert!(body.starts_with(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"scope\"\r\n\r\npersonal\r\n")));
        assert!(body.contains("name=\"files\"; filename=\"a.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\nID3audio\r\n"));
        assert!(body.ends_with(&format!("--{boundary}--\r\n")));
        let seen = seen.lock().unwrap();
        let (sent, total) = *seen.last().unwrap();
        assert_eq!(sent, total);
        assert_eq!(total, req.body.len() as u64);
    }

    // api.test.ts: form upload fetch
    #[test]
    fn a_failed_upload_with_no_body_reads_as_the_fallback() {
        let server = MockServer::start(vec![Res::new(502)]);
        let path = temp_file("cover.jpg", b"jpeg");
        let err = set_album_cover(&server.client(), "a1", &path).unwrap_err();
        assert!(err.is_api_error());
        assert_eq!(err.status, 502);
        assert_eq!(error_message(&err, "Couldn't use that image."), "Couldn't use that image.");
        let req = &server.requests()[0];
        assert_eq!((req.method.as_str(), req.path.as_str()), ("PUT", "/api/albums/a1/cover"));
        assert!(req.text().contains("Content-Type: image/jpeg"));
        assert_eq!(error_message(&ApiError::http(413, "too large"), "fallback"), "too large");
    }

    #[test]
    fn names_are_quoted_like_browsers_do() {
        let (_, body) = Multipart::new(vec![Part::bytes("f", "a\"b\nc.png", vec![1])]).to_bytes().unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("filename=\"a%22b%0Ac.png\""));
    }
}

/// Set a personal cover for an owned upload; server enforces ownership.
pub fn set_track_cover(c: &Client, id: &str, image: &Path) -> ApiResult<super::TrackDetail> {
    send_form(c, "PUT", &format!("/api/tracks/{}/cover", seg(id)), Multipart::new(vec![Part::file("file", image)]), None)
}
