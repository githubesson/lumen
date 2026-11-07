//! What Electron's frameless window has on Windows and winit's borderless one
//! lacks, added by subclassing the window procedure:
//!
//! - **Resize edges.** winit answers `WM_NCCALCSIZE` with the whole window as
//!   client area, so `DefWindowProc` hit-tests everything as `HTCLIENT`. This
//!   answers `WM_NCHITTEST` with Electron's `FramelessView` metrics: a 5 px
//!   strip inside the edge, 16 px corners, none while maximized, and
//!   `HTBORDER` while the window can't resize (the mini player).
//! - **Snap and Win+arrows** come with the styles winit keeps on a borderless
//!   window (`WS_CAPTION | WS_SIZEBOX | WS_MAXIMIZEBOX`); Rune's drag regions
//!   move the window through `HTCAPTION`, which snaps.
//! - **Maximized bounds.** winit puts a maximized window's client area on the
//!   monitor's work area; like Chromium this leaves a pixel for an
//!   auto-hiding taskbar, which otherwise can't come up over the window.
//! - **The mini player** pins its size (`WM_GETMINMAXINFO`) and drops
//!   `WS_THICKFRAME | WS_MAXIMIZEBOX` (Electron's `setResizable(false)` and
//!   `setMaximizable(false)`), also when winit rewrites the styles.
//! - **No DWM chrome.** Electron's transparent frameless window has no system
//!   border, shadow or corner rounding; the app draws its own corners.
//! - **The icon** from the executable's resources, and the second-instance
//!   message ([`super::single_instance`]).

use std::cell::Cell;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Dwm::{
    DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND, DwmSetWindowAttribute,
};
use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL, MONITORINFO, MonitorFromRect};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows_sys::Win32::UI::Shell::{
    ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_GETAUTOHIDEBAREX, APPBARDATA, DefSubclassProc, RemoveWindowSubclass,
    SHAppBarMessage, SetWindowSubclass,
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

use super::window::{Edge, MINI_PLAYER_SIZE, NORMAL_SIZE, PanelAnchor, Rect};

const SUBCLASS: usize = 0x4c55_4d4e;
/// Electron's `kResizeInsideBoundsSize` and `kResizeAreaCornerSize`.
const RESIZE_BORDER: f64 = 5.0;
const RESIZE_CORNER: f64 = 16.0;
/// Chromium's `kAutoHideTaskbarThicknessPx`.
const AUTOHIDE_TASKBAR: i32 = 2;

thread_local! {
    /// The window's handle, once `install` has run (an `HWND` as an integer).
    static HWND_NOW: Cell<isize> = const { Cell::new(0) };
    /// The mini player's pinned size in points, while it's on.
    static PINNED: Cell<Option<(f64, f64)>> = const { Cell::new(None) };
}

fn hwnd() -> Option<HWND> {
    let raw = HWND_NOW.with(Cell::get);
    (raw != 0).then_some(raw as HWND)
}

fn scale(hwnd: HWND) -> f64 {
    // SAFETY: a live window owned by this thread.
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 }
}

fn window_rect(hwnd: HWND) -> Rect {
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    // SAFETY: writes one RECT.
    unsafe { GetWindowRect(hwnd, &mut r) };
    Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
}

fn monitor_info(rect: &RECT, default: u32) -> Option<MONITORINFO> {
    // SAFETY: MONITORINFO is plain data with its size set before the call.
    unsafe {
        let monitor = MonitorFromRect(rect, default);
        if monitor.is_null() {
            return None;
        }
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        (GetMonitorInfoW(monitor, &mut info) != 0).then_some(info)
    }
}

/// The work area of the display holding most of `bounds` (`screen.getDisplayMatching`).
fn work_area(bounds: Rect) -> Rect {
    let r = RECT { left: bounds.x, top: bounds.y, right: bounds.x + bounds.w, bottom: bounds.y + bounds.h };
    match monitor_info(&r, MONITOR_DEFAULTTONEAREST) {
        Some(info) => {
            let w = info.rcWork;
            Rect { x: w.left, y: w.top, w: w.right - w.left, h: w.bottom - w.top }
        }
        None => bounds,
    }
}

/// The window's bounds, the work area they're on and the window's scale.
pub fn geometry() -> Option<(Rect, Rect, f64)> {
    let hwnd = hwnd()?;
    let bounds = window_rect(hwnd);
    Some((bounds, work_area(bounds), scale(hwnd)))
}

fn set_bounds(hwnd: HWND, r: Rect) {
    // SAFETY: a live window owned by this thread.
    unsafe { SetWindowPos(hwnd, std::ptr::null_mut(), r.x, r.y, r.w, r.h, SWP_NOZORDER | SWP_NOACTIVATE) };
}

/// Through `WM_SYSCOMMAND`, so winit's idea of the window's state follows.
pub fn minimize() -> bool {
    let Some(h) = hwnd() else { return false };
    // SAFETY: a live window owned by this thread.
    unsafe { SendMessageW(h, WM_SYSCOMMAND, SC_MINIMIZE as WPARAM, 0) };
    true
}

pub fn toggle_maximize() -> bool {
    let Some(h) = hwnd() else { return false };
    // SAFETY: a live window owned by this thread. winit follows the change in WM_SIZE.
    unsafe {
        ShowWindow(h, if IsZoomed(h) != 0 { SW_RESTORE } else { SW_MAXIMIZE });
        IsZoomed(h) != 0
    }
}

/// Adds or drops what makes the window resizable and maximizable.
fn set_resizable(hwnd: HWND, resizable: bool) {
    let bits = (WS_THICKFRAME | WS_MAXIMIZEBOX) as i32;
    // SAFETY: style changes on a live window owned by this thread; the
    // subclass keeps them while the mini player is on.
    unsafe {
        let style = GetWindowLongW(hwnd, GWL_STYLE);
        let next = if resizable { style | bits } else { style & !bits };
        if next != style {
            SetWindowLongW(hwnd, GWL_STYLE, next);
            SetWindowPos(hwnd, std::ptr::null_mut(), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        }
    }
}

/// `setMiniPlayerMode`'s window work; returns the bounds to restore later.
pub fn enter_or_leave_mini(enabled: bool, normal: Option<Rect>) -> Option<Rect> {
    let hwnd = hwnd()?;
    if enabled {
        // SAFETY: a live window owned by this thread.
        let maximized = unsafe { IsZoomed(hwnd) } != 0;
        let saved = if maximized { None } else { Some(window_rect(hwnd)) };
        if maximized {
            // SAFETY: as above.
            unsafe { ShowWindow(hwnd, SW_RESTORE) };
        }
        PINNED.with(|p| p.set(Some(MINI_PLAYER_SIZE)));
        set_resizable(hwnd, false);
        let bounds = window_rect(hwnd);
        let size = super::window::physical(MINI_PLAYER_SIZE, scale(hwnd));
        set_bounds(hwnd, super::window::bounds_around_center(bounds, size, work_area(bounds)));
        saved
    } else {
        PINNED.with(|p| p.set(None));
        set_resizable(hwnd, true);
        match normal {
            Some(r) => set_bounds(hwnd, r),
            None => {
                let (w, h) = super::window::physical(NORMAL_SIZE, scale(hwnd));
                // SAFETY: a live window owned by this thread.
                unsafe { SetWindowPos(hwnd, std::ptr::null_mut(), 0, 0, w, h, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE) };
            }
        }
        None
    }
}

/// `setMiniPlayerPanel`'s window work.
pub fn resize_mini(size: (f64, f64), anchor: PanelAnchor, open: bool) {
    let Some(hwnd) = hwnd() else { return };
    let bounds = window_rect(hwnd);
    let px = super::window::physical(size, scale(hwnd));
    PINNED.with(|p| p.set(Some(size)));
    set_bounds(hwnd, super::window::panel_bounds(bounds, px, anchor, work_area(bounds), open));
}

fn edge_code(edge: Edge) -> u32 {
    match edge {
        Edge::Left => HTLEFT,
        Edge::Right => HTRIGHT,
        Edge::Top => HTTOP,
        Edge::Bottom => HTBOTTOM,
        Edge::TopLeft => HTTOPLEFT,
        Edge::TopRight => HTTOPRIGHT,
        Edge::BottomLeft => HTBOTTOMLEFT,
        Edge::BottomRight => HTBOTTOMRIGHT,
    }
}

/// `GetAppbarAutohideEdges`: the edges of `monitor` with an auto-hiding taskbar.
fn autohide_edges(monitor: RECT) -> [bool; 4] {
    let mut edges = [false; 4];
    for (i, edge) in [ABE_LEFT, ABE_TOP, ABE_RIGHT, ABE_BOTTOM].into_iter().enumerate() {
        // SAFETY: APPBARDATA is plain data with its size set.
        let bar = unsafe {
            let mut data: APPBARDATA = std::mem::zeroed();
            data.cbSize = std::mem::size_of::<APPBARDATA>() as u32;
            data.uEdge = edge;
            data.rc = monitor;
            SHAppBarMessage(ABM_GETAUTOHIDEBAREX, &mut data)
        };
        edges[i] = bar != 0;
    }
    edges
}

unsafe extern "system" fn subclass(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _: usize, _: usize) -> LRESULT {
    // SAFETY (whole function): Windows calls this on the window's thread with
    // the message's documented parameters; DefSubclassProc forwards to winit.
    unsafe {
        match msg {
            WM_NCHITTEST => {
                let hit = DefSubclassProc(hwnd, msg, wparam, lparam);
                if hit != HTCLIENT as LRESULT || IsZoomed(hwnd) != 0 {
                    return hit;
                }
                let point = POINT { x: (lparam & 0xffff) as i16 as i32, y: ((lparam >> 16) & 0xffff) as i16 as i32 };
                let r = window_rect(hwnd);
                let s = scale(hwnd);
                let edge = super::window::frame_edge(
                    point.x - r.x,
                    point.y - r.y,
                    r.w,
                    r.h,
                    (RESIZE_BORDER * s).round() as i32,
                    (RESIZE_CORNER * s).round() as i32,
                );
                return match edge {
                    None => hit,
                    Some(_) if PINNED.with(Cell::get).is_some() => HTBORDER as LRESULT,
                    Some(edge) => edge_code(edge) as LRESULT,
                };
            }
            WM_GETMINMAXINFO => {
                let result = DefSubclassProc(hwnd, msg, wparam, lparam);
                if let Some(size) = PINNED.with(Cell::get) {
                    let (w, h) = super::window::physical(size, scale(hwnd));
                    let info = &mut *(lparam as *mut MINMAXINFO);
                    info.ptMinTrackSize = POINT { x: w, y: h };
                    info.ptMaxTrackSize = POINT { x: w, y: h };
                }
                return result;
            }
            WM_STYLECHANGING if wparam as i32 == GWL_STYLE && PINNED.with(Cell::get).is_some() => {
                let change = &mut *(lparam as *mut STYLESTRUCT);
                change.styleNew &= !(WS_THICKFRAME | WS_MAXIMIZEBOX);
            }
            WM_SIZE if wparam == SIZE_MAXIMIZED as WPARAM && PINNED.with(Cell::get).is_some() => {
                // Maximized some other way (a drag region's double click): the
                // mini player isn't maximizable.
                PostMessageW(hwnd, WM_SYSCOMMAND, SC_RESTORE as WPARAM, 0);
            }
            WM_NCCALCSIZE if wparam != 0 && IsZoomed(hwnd) != 0 => {
                let result = DefSubclassProc(hwnd, msg, wparam, lparam);
                let params = &mut *(lparam as *mut NCCALCSIZE_PARAMS);
                let client = &mut params.rgrc[0];
                if let Some(info) = monitor_info(client, MONITOR_DEFAULTTONULL) {
                    let [left, top, right, bottom] = autohide_edges(info.rcMonitor);
                    if left {
                        client.left += AUTOHIDE_TASKBAR;
                    }
                    if top {
                        // A frameless window can't push its top down (Chromium).
                        client.bottom -= 1;
                    }
                    if right {
                        client.right -= AUTOHIDE_TASKBAR;
                    }
                    if bottom {
                        client.bottom -= AUTOHIDE_TASKBAR;
                    }
                }
                return result;
            }
            WM_NCDESTROY => {
                RemoveWindowSubclass(hwnd, Some(subclass), SUBCLASS);
                HWND_NOW.with(|h| h.set(0));
            }
            _ if msg != 0 && msg == super::single_instance::activate_message() => {
                // A second launch: bring this window forward instead.
                if IsIconic(hwnd) != 0 {
                    ShowWindow(hwnd, SW_RESTORE);
                }
                SetForegroundWindow(hwnd);
                return 0;
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}

/// The executable's icon (resource 1, `packaging/windows`) at `size` pixels.
fn load_icon(size: i32) -> HICON {
    // SAFETY: loads a resource from this module; a missing one gives null.
    unsafe { LoadImageW(GetModuleHandleW(std::ptr::null()), 1 as _, IMAGE_ICON, size, size, LR_DEFAULTCOLOR) as HICON }
}

/// Fits the window out natively; runs after every native creation.
pub fn install(handle: &rune::WindowHandle) {
    let raw = handle.with_raw_handle(|h| match h.as_raw() {
        rune::raw_window_handle::RawWindowHandle::Win32(w) => w.hwnd.get(),
        _ => 0,
    });
    let Ok(raw) = raw else { return };
    if raw == 0 {
        return;
    }
    HWND_NOW.with(|h| h.set(raw));
    let hwnd = raw as HWND;
    // SAFETY: Win32 calls on the live window this thread owns.
    unsafe {
        SetWindowSubclass(hwnd, Some(subclass), SUBCLASS, 0);
        let corners: i32 = DWMWCP_DONOTROUND;
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE as u32, (&raw const corners).cast(), 4);
        let border: u32 = DWMWA_COLOR_NONE;
        DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR as u32, (&raw const border).cast(), 4);
        let dpi = GetDpiForWindow(hwnd);
        let big = load_icon(GetSystemMetricsForDpi(SM_CXICON, dpi));
        let small = load_icon(GetSystemMetricsForDpi(SM_CXSMICON, dpi));
        if !big.is_null() {
            SendMessageW(hwnd, WM_SETICON, ICON_BIG as WPARAM, big as LPARAM);
        }
        if !small.is_null() {
            SendMessageW(hwnd, WM_SETICON, ICON_SMALL as WPARAM, small as LPARAM);
        }
    }
    // A window recreated mid mini-player keeps it.
    if PINNED.with(Cell::get).is_some() {
        set_resizable(hwnd, false);
    }
}
