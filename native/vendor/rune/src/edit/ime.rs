//! Input method events: what the platform's input method (dead keys, CJK, the emoji picker,
//! dictation) composes, for the focused `text_input` or an app's own editor (`App::on_ime`).
use zeroize::Zeroize;

/// One input method event. Plain typing arrives as keys (`Key::Text`); these carry what an
/// input method composed.
#[derive(Clone, Debug, PartialEq)]
pub enum Ime {
    /// The composition so far (marked text), drawn at the caret and not yet part of the text,
    /// with the byte range of its cursor or selection in it. Empty ends the composition.
    Preedit(String, Option<(usize, usize)>),
    /// Text to insert at the caret, replacing the preedit.
    Commit(String),
    /// The window's input method turned on for the caret that takes text (a focused
    /// `text_input` or an `El::ime_cursor` surface), or off again. Informational: Rune turns it
    /// on and off.
    Enabled,
    Disabled,
}

impl Drop for Ime {
    fn drop(&mut self) {
        match self {
            Self::Preedit(text, _) | Self::Commit(text) => text.zeroize(),
            Self::Enabled | Self::Disabled => {}
        }
    }
}
