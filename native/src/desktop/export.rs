//! `electron/track-export.ts` and the `tracks:export-files` handler: saves
//! track files into a folder the user picks. Only the server's own `/api/`
//! paths are fetched, and the session cookie goes to the server alone, never
//! along a redirect to another host.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::api::Client;
use crate::app::App;

/// `ExportTrackFileItem`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExportItem {
    /// An API path, `/api/tracks/<id>/stream?download=1`.
    pub url: String,
    pub filename: String,
}

/// `ExportTrackFilesResult`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExportResult {
    pub ok: bool,
    pub canceled: bool,
    pub folder: Option<PathBuf>,
    pub saved: usize,
    pub failed: usize,
    /// The first five failures, "file: why".
    pub errors: Vec<String>,
    pub error: Option<String>,
}

const TIMEOUT: Duration = Duration::from_secs(120);
const MAX_REDIRECTS: usize = 5;

/// Asks for a folder, then downloads `items` into it in the background;
/// `done` gets the outcome on the UI thread.
pub fn export_track_files(
    app: &App,
    tx: &mut rune::Tx,
    items: Vec<ExportItem>,
    done: impl FnOnce(&mut App, ExportResult) + Send + 'static,
) {
    let items: Vec<ExportItem> = items.into_iter().filter(|i| !i.url.trim().is_empty() && !i.filename.trim().is_empty()).collect();
    let Some(client) = app.client.clone().filter(|_| !items.is_empty()) else {
        let error = if items.is_empty() { "No files selected for export." } else { "Not connected to a server." };
        app.net.sender().send(move |app| done(app, ExportResult { error: Some(error.into()), ..ExportResult::default() }));
        return;
    };
    let options = rune::FileDialogOptions { title: "Choose export folder".into(), ..Default::default() };
    tx.open_folder(options, move |app: &mut App, result, _tx| match result {
        Ok(Some(folder)) => {
            app.net.run(move || export_into(&client, &folder, &items), done);
        }
        Ok(None) => done(app, ExportResult { canceled: true, ..ExportResult::default() }),
        Err(e) => done(app, ExportResult { error: Some(e.to_string()), ..ExportResult::default() }),
    });
}

/// Downloads every item into `folder` (blocking).
pub fn export_into(client: &Client, folder: &Path, items: &[ExportItem]) -> ExportResult {
    let mut result = ExportResult { folder: Some(folder.to_path_buf()), ..ExportResult::default() };
    let cookie = client.cookie_header();
    for item in items {
        let outcome = export_url(client, &item.url).and_then(|url| {
            let dest = unique_export_path(folder, &item.filename)?;
            download_to_file(client, &url, &dest, cookie.as_deref())
        });
        match outcome {
            Ok(()) => result.saved += 1,
            Err(e) => {
                result.failed += 1;
                if result.errors.len() < 5 {
                    result.errors.push(format!("{}: {e}", item.filename));
                }
            }
        }
    }
    result.ok = result.failed == 0;
    result
}

/// `exportDownloadUrl`: only relative `/api/` paths, on the server.
pub fn export_url(client: &Client, input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Missing download URL".into());
    }
    if !trimmed.starts_with("/api/") {
        return Err("Export URL must be an API path".into());
    }
    Ok(client.url(trimmed))
}

/// `sanitizeExportFilename`.
pub fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let replaced: String = base.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 { '_' } else { c }).collect();
    let mut collapsed = String::with_capacity(replaced.len());
    let mut space = false;
    for c in replaced.chars() {
        if c.is_whitespace() {
            if !space {
                collapsed.push(' ');
            }
            space = true;
        } else {
            collapsed.push(c);
            space = false;
        }
    }
    let trimmed = collapsed.trim_end_matches(['.', ' ']);
    // `.slice(0, 180)` in UTF-16 units, without splitting a character.
    let mut units = 0;
    let end = trimmed.char_indices().find(|(_, c)| {
        units += c.len_utf16();
        units > 180
    });
    let cut = end.map_or(trimmed, |(i, _)| &trimmed[..i]);
    if cut.is_empty() { "track".into() } else { cut.to_string() }
}

/// `uniqueExportPath`: `name.ext`, else `name (1).ext`, `name (2).ext`…
pub fn unique_export_path(folder: &Path, filename: &str) -> Result<PathBuf, String> {
    let safe = sanitize_filename(filename);
    let (stem, ext) = match safe.rfind('.') {
        Some(i) if i > 0 => (&safe[..i], &safe[i..]),
        _ => (safe.as_str(), ""),
    };
    let stem = if stem.is_empty() { "track" } else { stem };
    for i in 0..10_000 {
        let candidate = folder.join(if i == 0 { format!("{stem}{ext}") } else { format!("{stem} ({i}){ext}") });
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Could not choose a unique filename".into())
}

/// `downloadToFile`: follows up to five redirects, sending the cookie only to
/// the server, and writes `dest` fresh (never over a file that appeared meanwhile).
fn download_to_file(client: &Client, url: &str, dest: &Path, cookie: Option<&str>) -> Result<(), String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_global(Some(TIMEOUT))
        .user_agent(super::USER_AGENT)
        .build()
        .into();
    let mut current = url::Url::parse(url).map_err(|e| e.to_string())?;
    for _ in 0..=MAX_REDIRECTS {
        let mut request = agent.get(current.as_str()).header("Accept", "application/octet-stream,*/*");
        // Re-evaluated per hop: a redirect to another host never gets the session.
        if let Some(cookie) = cookie.filter(|_| client.is_api_origin(current.as_str())) {
            request = request.header("Cookie", cookie);
        }
        let mut response = request.call().map_err(|e| match e {
            ureq::Error::Timeout(_) => "Download timed out".to_string(),
            other => other.to_string(),
        })?;
        let status = response.status().as_u16();
        if (300..400).contains(&status)
            && let Some(location) = response.headers().get("location").and_then(|v| v.to_str().ok())
        {
            current = current.join(location).map_err(|e| e.to_string())?;
            continue;
        }
        if !(200..300).contains(&status) {
            return Err(format!("HTTP {status}"));
        }
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(dest).map_err(|e| e.to_string())?;
        let copied = (|| -> std::io::Result<()> {
            let mut reader = response.body_mut().with_config().limit(u64::MAX).reader();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = reader.read(&mut buf)?;
                if n == 0 {
                    return file.flush();
                }
                file.write_all(&buf[..n])?;
            }
        })();
        return copied.map_err(|e| {
            drop(std::fs::remove_file(dest));
            e.to_string()
        });
    }
    Err("Too many redirects".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_filenames_safe() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename(r"C:\x\a<b>:c?.flac"), "a_b__c_.flac");
        assert_eq!(sanitize_filename("  two   spaces\t.mp3 . "), " two spaces_.mp3");
        assert_eq!(sanitize_filename("..."), "track");
        assert_eq!(sanitize_filename(&"é".repeat(300)).chars().count(), 180);
    }

    #[test]
    fn picks_a_name_no_file_has() {
        let dir = std::env::temp_dir().join(format!("lumen-export-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_export_path(&dir, "Song.flac").unwrap();
        assert_eq!(first.file_name().unwrap(), "Song.flac");
        std::fs::write(&first, b"x").unwrap();
        assert_eq!(unique_export_path(&dir, "Song.flac").unwrap().file_name().unwrap(), "Song (1).flac");
        assert_eq!(unique_export_path(&dir, "noext").unwrap().file_name().unwrap(), "noext");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_fetches_api_paths_on_the_server() {
        let client = Client::new("https://music.example.com", None);
        assert_eq!(export_url(&client, " /api/tracks/t1/stream?download=1 ").unwrap(), "https://music.example.com/api/tracks/t1/stream?download=1");
        assert_eq!(export_url(&client, "https://evil.example/x"), Err("Export URL must be an API path".into()));
        assert_eq!(export_url(&client, "  "), Err("Missing download URL".into()));
    }
}
