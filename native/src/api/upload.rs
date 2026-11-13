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
                    Some(Segment::File(p, len)) => self.current = Some(Box::new(WholeFile(File::open(p)?.take(len)))),
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

/// A file part, read for exactly the length the body was measured with: a
/// file that got shorter since fails the body, where stopping short of its
/// `Content-Length` would leave the server waiting for the rest for good.
struct WholeFile(io::Take<File>);

impl Read for WholeFile {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.0.read(buf)?;
        if n == 0 && !buf.is_empty() && self.0.limit() > 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "a file got shorter while it was being sent"));
        }
        Ok(n)
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
/// `cancel` aborts it as the web's `AbortSignal` does: the connection
/// closes, so the call returns at once, mid-body or waiting for the answer,
/// and the server undoes what the request had added. An answer read whole
/// before the cancel is returned as it is.
pub fn upload_music(
    c: &Client,
    files: &[PathBuf],
    scope: crate::core::upload::UploadScope,
    cancel: &super::Cancel,
) -> ApiResult<Vec<UploadResult>> {
    cancel.check()?;
    let mut parts = vec![Part::text("scope", scope.as_str())];
    parts.extend(files.iter().map(|f| Part::file("files", f)));
    let results: Option<Vec<UploadResult>> = send_form(&c.with_cancel(cancel), "POST", "/api/library/upload", Multipart::new(parts), None)?;
    Ok(results.unwrap_or_default())
}

/// Admin: replace an album's cover with an image file.
pub fn set_album_cover(c: &Client, id: &str, image: &Path) -> ApiResult<Album> {
    send_form(c, "PUT", &format!("/api/albums/{}/cover", seg(id)), Multipart::new(vec![Part::file("file", image)]), None)
}

/// `setTrackCover`: the uploader's own cover for a track they own (only
/// they see it); the server checks the ownership.
pub fn set_track_cover(c: &Client, id: &str, image: &Path) -> ApiResult<super::TrackDetail> {
    send_form(c, "PUT", &format!("/api/tracks/{}/cover", seg(id)), Multipart::new(vec![Part::file("file", image)]), None)
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
    fn streams_files() {
        let server = MockServer::start(vec![Res::json(r#"[{"file":"a.mp3","inserted":true,"promoted":true}]"#)]);
        let path = temp_file("a.mp3", b"ID3audio");
        let cancel = crate::api::Cancel::new();
        let results = upload_music(&server.client(), &[path], crate::core::upload::UploadScope::Personal, &cancel).unwrap();
        assert!(results[0].inserted && results[0].promoted == Some(true));
        let req = &server.requests()[0];
        assert_eq!((req.method.as_str(), req.path.as_str()), ("POST", "/api/library/upload"));
        let ct = req.header("content-type").unwrap();
        let boundary = ct.strip_prefix("multipart/form-data; boundary=").unwrap();
        let body = req.text();
        assert!(body.starts_with(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"scope\"\r\n\r\npersonal\r\n")));
        assert!(body.contains("name=\"files\"; filename=\"a.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\nID3audio\r\n"));
        assert!(body.ends_with(&format!("--{boundary}--\r\n")));
    }

    #[test]
    fn a_body_reports_its_progress() {
        let path = temp_file("b.mp3", b"ID3audio");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        let form = Multipart::new(vec![Part::text("scope", "personal"), Part::file("files", &path)]);
        let Body::Stream { len, mut reader, .. } = form.into_body(Some(progress(move |sent, total| s2.lock().unwrap().push((sent, total))))).unwrap() else {
            panic!("a form streams")
        };
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        let (sent, total) = *seen.lock().unwrap().last().unwrap();
        assert_eq!((sent, total), (len, len));
        assert_eq!(bytes.len() as u64, len);
    }

    #[test]
    fn a_cancelled_upload_never_starts() {
        let cancel = crate::api::Cancel::new();
        cancel.cancel();
        let server = MockServer::start(vec![]);
        let path = temp_file("c.mp3", b"ID3audio");
        let err = upload_music(&server.client(), &[path], crate::core::upload::UploadScope::Personal, &cancel).unwrap_err();
        assert!(err.is_aborted());
        assert!(server.requests().is_empty());
    }

    /// A server for one request: reads its head and hands it over with the
    /// connection.
    fn one_request(then: impl FnOnce(std::net::TcpStream, String) + Send + 'static) -> Client {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut head = Vec::new();
            let mut byte = [0];
            while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                head.push(byte[0]);
            }
            then(stream, String::from_utf8_lossy(&head).to_lowercase());
        });
        Client::new(&base, None)
    }

    fn content_length(head: &str) -> u64 {
        head.lines().find_map(|l| l.strip_prefix("content-length:")).unwrap().trim().parse().unwrap()
    }

    /// Upload `size` bytes to a server that reads `read` of them (all when
    /// `None`) and then just waits; cancel. What the upload returned, how
    /// long after the cancel, and what the server got of the body before
    /// the connection closed (`None` if it never closed).
    fn cancel_while_the_server_holds(name: &str, size: usize, read: Option<u64>) -> (ApiError, std::time::Duration, Option<u64>, u64) {
        use std::io::Write;
        use std::sync::mpsc::channel;
        use std::time::Duration;
        let (ready, holding) = channel();
        let (resume, resumed) = channel::<()>();
        let (closed, got) = channel();
        let client = one_request(move |mut stream, head| {
            let len = content_length(&head);
            stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").unwrap();
            let want = read.unwrap_or(len);
            let mut body = Vec::new();
            (&mut stream).take(want).read_to_end(&mut body).unwrap();
            ready.send(len).unwrap();
            // Past the cancel: the rest, if any, until the client goes (or 10 s pass).
            let _ = resumed.recv();
            stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let mut total = body.len() as u64;
            let mut buf = vec![0; 64 * 1024];
            let end = loop {
                match stream.read(&mut buf) {
                    Ok(0) => break Some(total),
                    Ok(n) => total += n as u64,
                    Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => break None,
                    Err(_) => break Some(total),
                }
            };
            let _ = closed.send(end);
        });
        let path = temp_file(name, &vec![7u8; size]);
        let file = path.clone();
        let cancel = crate::api::Cancel::new();
        let c2 = cancel.clone();
        let (sent, answer) = channel();
        std::thread::spawn(move || {
            let _ = sent.send(upload_music(&client, &[path], crate::core::upload::UploadScope::Personal, &c2));
        });
        let len = holding.recv_timeout(Duration::from_secs(10)).expect("the server got the request");
        std::thread::sleep(Duration::from_millis(100));
        cancel.cancel();
        let started = std::time::Instant::now();
        let err = answer.recv_timeout(Duration::from_secs(5)).expect("the upload returned").unwrap_err();
        let elapsed = started.elapsed();
        resume.send(()).unwrap();
        let got = got.recv_timeout(Duration::from_secs(15)).unwrap();
        let _ = std::fs::remove_file(file);
        (err, elapsed, got, len)
    }

    #[test]
    fn a_cancel_closes_the_connection_awaiting_the_answer_so_the_server_sees_it() {
        let (err, elapsed, got, len) = cancel_while_the_server_holds("held.mp3", 1024, None);
        assert!(err.is_aborted(), "{err:?}");
        assert!(elapsed < std::time::Duration::from_secs(2));
        assert_eq!(got, Some(len));
    }

    #[test]
    fn a_cancel_closes_the_connection_mid_body() {
        // Far more than the socket buffers hold, so the client is stuck writing.
        let (err, elapsed, got, len) = cancel_while_the_server_holds("big.mp3", 32 << 20, Some(64 * 1024));
        assert!(err.is_aborted(), "{err:?}");
        assert!(elapsed < std::time::Duration::from_secs(2));
        let got = got.expect("the connection closed");
        assert!(got < len, "{got} of {len}");
    }

    #[test]
    fn a_rate_limit_answered_before_the_body_is_read_isnt_lost() {
        use std::io::Write;
        // As Go answers from middleware: no 100 Continue, and the body left unread.
        let client = one_request(|mut stream, head| {
            assert!(head.contains("expect: 100-continue"), "{head}");
            let _ = stream.write_all(
                b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 7\r\nContent-Type: text/plain\r\nContent-Length: 19\r\nConnection: close\r\n\r\nrate limit exceeded",
            );
            let _ = stream.flush();
        });
        let path = temp_file("limited.mp3", &vec![7u8; 8 << 20]);
        let err = upload_music(&client, &[path.clone()], crate::core::upload::UploadScope::Personal, &crate::api::Cancel::new()).unwrap_err();
        let _ = std::fs::remove_file(path);
        assert!(err.has_status(429), "{err:?}");
        assert_eq!((err.message.as_str(), err.retry_after_seconds), ("rate limit exceeded", Some(7)));
    }

    #[test]
    fn a_file_that_got_shorter_fails_the_body_instead_of_hanging() {
        let path = temp_file("shrinks.mp3", b"ID3audio-and-more");
        let form = Multipart::new(vec![Part::text("scope", "personal"), Part::file("files", &path)]);
        let Body::Stream { mut reader, .. } = form.into_body(None).unwrap() else { panic!("a form streams") };
        std::fs::write(&path, b"ID3").unwrap();
        let err = reader.read_to_end(&mut Vec::new()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
        // Sent, the request fails rather than waiting on the server for good.
        std::fs::write(&path, b"ID3audio-and-more").unwrap();
        let server = MockServer::start(vec![Res::json("[]")]);
        let body = Multipart::new(vec![Part::file("files", &path)]).into_body(None).unwrap();
        std::fs::write(&path, b"ID3").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let client = server.client();
        std::thread::spawn(move || {
            let _ = tx.send(client.request("POST", "/api/library/upload", body, &[], &Default::default()).map(|_| ()));
        });
        let result = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("the request ended");
        assert_eq!(result.unwrap_err().kind, crate::api::ErrorKind::Network);
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
