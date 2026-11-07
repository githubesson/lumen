//! Saving a download where a browser would (the web's `lib/download.ts`
//! hands the file to the browser; see `audio_format` for its name).

/// Save `bytes` as `name` in the downloads folder (the temp folder when
/// there is none), numbered when a file already has the name, as a browser
/// saves a download.
pub fn save_to_downloads(name: &str, bytes: &[u8]) -> std::io::Result<std::path::PathBuf> {
    let dir = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
    let path = unique_path(&dir, name);
    std::fs::write(&path, bytes)?;
    Ok(path)
}

/// `name` in `dir`, or `name (1)`, `name (2)`… before its extension when
/// a file already has it.
fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    (1..1000)
        .map(|n| dir.join(if ext.is_empty() { format!("{stem} ({n})") } else { format!("{stem} ({n}).{ext}") }))
        .find(|p| !p.exists())
        .unwrap_or(first)
}
