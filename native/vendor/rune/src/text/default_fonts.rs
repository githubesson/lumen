//! The fonts text falls back to when the app registers none.
//!
//! Lumen patch: honor the `embedded-fonts` feature on native builds too, so apps
//! that supply their own `AppSpec::fonts` (Lumen bundles Geist) omit the 1.22 MB
//! of unused Inter TTFs.

#[cfg(all(not(target_arch = "wasm32"), any(test, feature = "embedded-fonts")))]
pub(super) const DEFAULT_FONTS: &[&[u8]] = &[
    include_bytes!("../../assets/Inter-Regular.ttf"),
    include_bytes!("../../assets/Inter-Medium.ttf"),
    include_bytes!("../../assets/Inter-SemiBold.ttf"),
];
#[cfg(all(not(target_arch = "wasm32"), not(any(test, feature = "embedded-fonts"))))]
pub(super) const DEFAULT_FONTS: &[&[u8]] = &[];
#[cfg(all(target_arch = "wasm32", any(test, feature = "embedded-fonts")))]
pub(super) const DEFAULT_FONTS: &[&[u8]] = &[
    include_bytes!("../../assets/Inter-Regular.ttf"),
    include_bytes!("../../assets/Inter-Medium.ttf"),
    include_bytes!("../../assets/Inter-SemiBold.ttf"),
    include_bytes!("../../assets/IBMPlexMono-Regular.ttf"),
];
#[cfg(all(target_arch = "wasm32", not(any(test, feature = "embedded-fonts"))))]
pub(super) const DEFAULT_FONTS: &[&[u8]] = &[];
