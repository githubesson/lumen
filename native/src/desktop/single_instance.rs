//! `app.requestSingleInstanceLock()` and its `second-instance` handler: a
//! second launch brings the running window forward (restored if minimized)
//! and quits. Instances with different data directories (`LUMEN_DATA_DIR`)
//! don't count as the same app, as Electron's lock is per `userData`.
//!
//! Windows holds a named mutex, and a second launch broadcasts a registered
//! message the first instance's window answers ([`super::win32`]); it lets
//! that window take the foreground first, which Windows otherwise refuses a
//! background process. Elsewhere the first instance listens on a socket in
//! the data directory.

use std::sync::OnceLock;

/// The data directory, as a short stable key.
#[cfg_attr(not(windows), allow(dead_code))]
fn key() -> String {
    let dir = crate::config::data_dir();
    let text = dir.to_string_lossy().to_lowercase();
    // FNV-1a: stable across runs and builds, unlike `DefaultHasher`.
    let hash = text.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
    format!("{hash:016x}")
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The message a second launch broadcasts (0 before it's registered).
#[cfg(windows)]
pub fn activate_message() -> u32 {
    static MESSAGE: OnceLock<u32> = OnceLock::new();
    *MESSAGE.get_or_init(|| {
        let name = wide(&format!("Lumen.Desktop.Activate.{}", key()));
        // SAFETY: a NUL-terminated UTF-16 string.
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::RegisterWindowMessageW(name.as_ptr()) }
    })
}

/// True when this is the only instance; false when another runs, which has
/// been asked to come forward (the caller then quits).
#[cfg(windows)]
pub fn acquire() -> bool {
    use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{ASFW_ANY, AllowSetForegroundWindow, HWND_BROADCAST, PostMessageW};
    let name = wide(&format!("Local\\Lumen.Desktop.{}", key()));
    // SAFETY: a NUL-terminated name; the handle stays open for the process's
    // life, which is what holds the lock.
    let (handle, error) = unsafe { (CreateMutexW(std::ptr::null(), 0, name.as_ptr()), GetLastError()) };
    if handle.is_null() || error != ERROR_ALREADY_EXISTS {
        return true;
    }
    let message = activate_message();
    // SAFETY: plain Win32 calls; the broadcast reaches top-level windows only.
    unsafe {
        AllowSetForegroundWindow(ASFW_ANY);
        PostMessageW(HWND_BROADCAST, message, 0, 0);
    }
    false
}

#[cfg(unix)]
static LISTENER: OnceLock<std::os::unix::net::UnixListener> = OnceLock::new();

#[cfg(unix)]
pub fn acquire() -> bool {
    use std::io::Write;
    use std::os::unix::net::{UnixListener, UnixStream};
    let path = crate::config::data_dir().join("instance.sock");
    if let Ok(mut other) = UnixStream::connect(&path) {
        let _ = other.write_all(b"activate\n");
        return false;
    }
    // Nobody answers: a socket left by an instance that crashed.
    let _ = std::fs::remove_file(&path);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(listener) = UnixListener::bind(&path) {
        let _ = LISTENER.set(listener);
    }
    true
}

/// Brings the window forward whenever a second launch asks.
#[cfg(unix)]
pub fn serve(handle: rune::AppHandle<crate::app::App>) {
    let Some(listener) = LISTENER.get() else { return };
    let Ok(listener) = listener.try_clone() else { return };
    let _ = std::thread::Builder::new().name("single-instance".into()).spawn(move || {
        for stream in listener.incoming() {
            if stream.is_ok() {
                handle.open();
            }
        }
    });
}

#[cfg(windows)]
pub fn serve(_: rune::AppHandle<crate::app::App>) {}

/// Lets the socket go when the app quits normally.
pub fn release() {
    #[cfg(unix)]
    if LISTENER.get().is_some() {
        let _ = std::fs::remove_file(crate::config::data_dir().join("instance.sock"));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn keys_the_lock_on_the_data_directory() {
        let a = super::key();
        assert_eq!(a, super::key());
        assert_eq!(a.len(), 16);
    }
}
