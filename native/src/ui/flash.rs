//! `useCopiedFlag(ms)`: a flag that turns itself back off `ms` after it was
//! last set ("Copied" on a copy button). Setting it again restarts the wait.

use std::time::Duration;

use crate::app::App;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Flag {
    on: bool,
    /// Bumped by each set: only the newest set's timer turns it off.
    generation: u64,
}

impl Flag {
    pub fn on(&self) -> bool {
        self.on
    }

    pub fn clear(&mut self) {
        self.on = false;
    }
}

/// Turn on the flag `lens` reaches, for `ms`.
pub fn flash(app: &mut App, lens: fn(&mut App) -> &mut Flag, ms: u64) {
    let flag = lens(app);
    flag.on = true;
    flag.generation += 1;
    let generation = flag.generation;
    app.net.after(Duration::from_millis(ms), move |app| {
        let flag = lens(app);
        if flag.generation == generation {
            flag.on = false;
        }
    });
}
