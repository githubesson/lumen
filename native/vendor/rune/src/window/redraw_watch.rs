//! Lumen patch: a frame a Wayland compositor never answers. A compositor may stop sending
//! frame callbacks to a window it doesn't show (another workspace, a hidden or minimised
//! window) without reporting it occluded, and winit then never delivers the redraw. A wake
//! or due timer on a shown window waits for that frame to poll, so the app's inbox (media
//! keys, MPRIS) would queue until the window shows again. Once a frame asked for a wake or
//! timer is `STALL` overdue, the host polls without it, as for a hidden window, and keeps
//! asking for the frame.
use std::time::{Duration, Instant};

/// How long a requested frame may take before the host stops waiting for it to poll.
pub(super) const STALL: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct RedrawWatch {
    /// When the oldest unanswered frame was asked for.
    asked: Option<Instant>,
    /// The stall's own poll ran (`take_due`); later wakes poll as they come.
    polled: bool,
}

impl RedrawWatch {
    /// A frame was asked for a wake or a due timer.
    pub(super) fn asked(&mut self, now: Instant) { self.asked.get_or_insert(now); }

    /// A frame came.
    pub(super) fn answered(&mut self) { *self = Self::default(); }

    /// The frame asked for is overdue: wakes and due timers poll without it.
    pub(super) fn stalled(&self, now: Instant) -> bool { self.asked.is_some_and(|t| now >= t + STALL) }

    /// When the poll the overdue frame would have run is due.
    pub(super) fn deadline(&self) -> Option<Instant> { self.asked.filter(|_| !self.polled).map(|t| t + STALL) }

    /// Whether that poll is due at `now`; it runs once a stall.
    pub(super) fn take_due(&mut self, now: Instant) -> bool {
        let due = !self.polled && self.stalled(now);
        self.polled |= due;
        due
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_overdue_polls_once_until_one_comes() {
        let t0 = Instant::now();
        let mut w = RedrawWatch::default();
        assert!(!w.stalled(t0 + STALL) && w.deadline().is_none(), "nothing asked");
        w.asked(t0);
        w.asked(t0 + STALL / 2);
        assert_eq!(w.deadline(), Some(t0 + STALL), "the oldest ask counts");
        assert!(!w.take_due(t0 + STALL / 2));
        assert!(w.take_due(t0 + STALL));
        assert!(!w.take_due(t0 + STALL * 3), "one poll a stall");
        assert!(w.stalled(t0 + STALL * 3) && w.deadline().is_none());
        w.answered();
        assert!(!w.stalled(t0 + STALL * 3) && w.deadline().is_none());
    }
}
