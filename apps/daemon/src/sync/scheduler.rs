//! Per-team sync trigger coalescing scheduler (pure logic, no I/O).
//!
//! Coalescing window + floor — not debounce. See
//! `docs/architecture/knowledge-sync-push-notify.md` §7 and ADR-0008.
//!
//! - First trigger opens a fixed 2s window; further triggers inside it merge;
//!   the window never resets.
//! - Floor from last tick **end**: Local 5s, Remote 15s; both pending → min.
//! - If the window closes before the floor, schedule at the floor (never drop).

use std::time::{Duration, Instant};

/// Fixed coalescing window after the first trigger in a batch.
pub const COALESCE_WINDOW: Duration = Duration::from_secs(2);
/// Minimum gap after a tick ends before a Local-driven fire.
pub const LOCAL_FLOOR: Duration = Duration::from_secs(5);
/// Minimum gap after a tick ends before a Remote-only fire.
pub const REMOTE_FLOOR: Duration = Duration::from_secs(15);

/// Why a sync was requested. Tasks 3 (fs watch) and 8 (MQTT hint) feed these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Local,
    Remote { seq: i64 },
}

/// Deterministic time source for the pure scheduler.
pub trait Clock {
    fn now(&self) -> Instant;
}

/// Wall-clock adapter for production drivers.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// Pure per-team coalescing state. No I/O; the dispatch layer calls
/// `sync_team` when [`Self::try_begin_tick`] returns true.
#[derive(Debug, Default)]
pub struct SyncScheduler {
    /// When the open coalescing window started. `None` when idle.
    window_opened_at: Option<Instant>,
    pending_local: bool,
    pending_remote: bool,
    /// Highest remote seq seen while pending (informational for later consumers).
    pending_remote_seq: Option<i64>,
    last_tick_end: Option<Instant>,
    in_tick: bool,
}

impl SyncScheduler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn in_tick(&self) -> bool {
        self.in_tick
    }

    pub fn pending_remote_seq(&self) -> Option<i64> {
        self.pending_remote_seq
    }

    fn has_pending(&self) -> bool {
        self.pending_local || self.pending_remote
    }

    fn floor_duration(&self) -> Duration {
        match (self.pending_local, self.pending_remote) {
            (true, true) => LOCAL_FLOOR.min(REMOTE_FLOOR),
            (true, false) => LOCAL_FLOOR,
            (false, true) => REMOTE_FLOOR,
            (false, false) => Duration::ZERO,
        }
    }

    /// Earliest allowed fire given an open window and pending kinds.
    fn compute_fire_at(&self) -> Option<Instant> {
        if self.in_tick || !self.has_pending() {
            return None;
        }
        let window_opened = self.window_opened_at?;
        let window_deadline = window_opened + COALESCE_WINDOW;
        let floor_deadline = self
            .last_tick_end
            .map(|end| end + self.floor_duration())
            .unwrap_or(window_deadline);
        Some(window_deadline.max(floor_deadline))
    }

    /// Record a trigger. Returns the next fire instant when work is pending
    /// and we are not mid-tick (mid-tick callers still accumulate pending;
    /// [`Self::end_tick`] returns the schedule).
    pub fn trigger<C: Clock>(&mut self, clock: &C, trigger: Trigger) -> Option<Instant> {
        let now = clock.now();
        match trigger {
            Trigger::Local => {
                self.pending_local = true;
            }
            Trigger::Remote { seq } => {
                self.pending_remote = true;
                self.pending_remote_seq = Some(match self.pending_remote_seq {
                    Some(prev) => prev.max(seq),
                    None => seq,
                });
            }
        }
        // First trigger of a batch opens a fixed window; further triggers merge.
        if self.window_opened_at.is_none() {
            self.window_opened_at = Some(now);
        }
        self.compute_fire_at()
    }

    /// Next scheduled fire, if any pending work exists and we are not in a tick.
    pub fn next_fire_at(&self) -> Option<Instant> {
        self.compute_fire_at()
    }

    /// If due at `clock.now()`, consume pending and enter `in_tick`.
    pub fn try_begin_tick<C: Clock>(&mut self, clock: &C) -> bool {
        if self.in_tick {
            return false;
        }
        let Some(fire_at) = self.compute_fire_at() else {
            return false;
        };
        if clock.now() < fire_at {
            return false;
        }
        self.pending_local = false;
        self.pending_remote = false;
        self.pending_remote_seq = None;
        self.window_opened_at = None;
        self.in_tick = true;
        true
    }

    /// Mark the tick finished. May return a new `next_fire_at` if triggers
    /// arrived during the tick.
    pub fn end_tick<C: Clock>(&mut self, clock: &C) -> Option<Instant> {
        let now = clock.now();
        self.in_tick = false;
        self.last_tick_end = Some(now);
        // Pending work that arrived mid-tick already opened a window; if somehow
        // pending without a window, open one now so we never drop.
        if self.has_pending() && self.window_opened_at.is_none() {
            self.window_opened_at = Some(now);
        }
        self.compute_fire_at()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct FakeClock {
        start: Instant,
        now: Cell<Instant>,
    }

    impl FakeClock {
        fn new() -> Self {
            let start = Instant::now();
            Self {
                start,
                now: Cell::new(start),
            }
        }

        fn advance(&self, d: Duration) {
            self.now.set(self.now.get() + d);
        }

        fn set_elapsed(&self, d: Duration) {
            self.now.set(self.start + d);
        }

        fn elapsed(&self) -> Duration {
            self.now.get().saturating_duration_since(self.start)
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            self.now.get()
        }
    }

    /// Drain due ticks at the current clock time (instantaneous ticks).
    fn drain_instant(sched: &mut SyncScheduler, clock: &FakeClock, fires: &mut Vec<Duration>) {
        while sched.try_begin_tick(clock) {
            fires.push(clock.elapsed());
            sched.end_tick(clock);
        }
    }

    #[test]
    fn quiet_one_local_fires_at_plus_2s() {
        let clock = FakeClock::new();
        let mut sched = SyncScheduler::new();

        let next = sched.trigger(&clock, Trigger::Local);
        assert_eq!(next, Some(clock.start + COALESCE_WINDOW));

        clock.advance(Duration::from_millis(1999));
        assert!(!sched.try_begin_tick(&clock));

        clock.advance(Duration::from_millis(1));
        assert!(sched.try_begin_tick(&clock));
        sched.end_tick(&clock);
    }

    #[test]
    fn burst_fifty_triggers_in_1_5s_exactly_one_fire() {
        let clock = FakeClock::new();
        let mut sched = SyncScheduler::new();
        let mut fires = Vec::new();

        for i in 0..50 {
            let t = Duration::from_millis(i * 1500 / 49);
            clock.set_elapsed(t);
            sched.trigger(&clock, Trigger::Local);
            drain_instant(&mut sched, &clock, &mut fires);
        }

        clock.set_elapsed(Duration::from_millis(1500));
        drain_instant(&mut sched, &clock, &mut fires);
        assert!(fires.is_empty(), "must not fire inside the 2s window: {fires:?}");

        clock.set_elapsed(COALESCE_WINDOW);
        drain_instant(&mut sched, &clock, &mut fires);
        assert_eq!(fires.len(), 1, "expected exactly one fire, got {fires:?}");
        assert_eq!(fires[0], COALESCE_WINDOW);

        clock.advance(Duration::from_secs(60));
        drain_instant(&mut sched, &clock, &mut fires);
        assert_eq!(fires.len(), 1, "no further fires without new triggers");
    }

    #[test]
    fn continuous_local_every_500ms_fires_at_2s_then_every_5s() {
        let clock = FakeClock::new();
        let mut sched = SyncScheduler::new();
        let mut fires = Vec::new();

        let mut t = Duration::ZERO;
        let end = Duration::from_secs(60);
        let step = Duration::from_millis(500);
        while t <= end {
            clock.set_elapsed(t);
            sched.trigger(&clock, Trigger::Local);
            drain_instant(&mut sched, &clock, &mut fires);
            t += step;
        }

        assert!(
            !fires.is_empty() && fires[0] == COALESCE_WINDOW,
            "first fire at ~2s, got {fires:?}"
        );

        // After the first fire, Local floor is 5s — never back-to-back (0 gap).
        for w in fires.windows(2) {
            let gap = w[1].saturating_sub(w[0]);
            assert!(
                gap >= LOCAL_FLOOR,
                "gap {gap:?} between {:?} and {:?} < local floor",
                w[0],
                w[1]
            );
            // Continuous writes keep the floor saturated: gaps ≈ 5s, not much more.
            assert!(
                gap <= LOCAL_FLOOR + step,
                "gap {gap:?} much larger than floor — coalescing stalled?"
            );
        }

        // Roughly one fire every 5s after the first: (60 - 2) / 5 ≈ 11 more → ~12 total.
        assert!(
            fires.len() >= 11 && fires.len() <= 13,
            "expected ~12 fires over 60s, got {} ({fires:?})",
            fires.len()
        );
    }

    #[test]
    fn remote_right_after_tick_ends_fires_at_plus_15s_not_2s() {
        let clock = FakeClock::new();
        let mut sched = SyncScheduler::new();

        sched.trigger(&clock, Trigger::Local);
        clock.advance(COALESCE_WINDOW);
        assert!(sched.try_begin_tick(&clock));
        sched.end_tick(&clock);

        let after_tick = clock.now();
        let next = sched.trigger(&clock, Trigger::Remote { seq: 42 });
        assert_eq!(next, Some(after_tick + REMOTE_FLOOR));

        clock.advance(COALESCE_WINDOW);
        assert!(
            !sched.try_begin_tick(&clock),
            "must not fire at window close when floor is 15s"
        );

        clock.set_elapsed(COALESCE_WINDOW + REMOTE_FLOOR);
        assert!(sched.try_begin_tick(&clock));
        sched.end_tick(&clock);
    }

    #[test]
    fn mixed_local_and_remote_pending_uses_5s_floor() {
        let clock = FakeClock::new();
        let mut sched = SyncScheduler::new();

        sched.trigger(&clock, Trigger::Local);
        clock.advance(COALESCE_WINDOW);
        assert!(sched.try_begin_tick(&clock));
        sched.end_tick(&clock);

        let after_tick = clock.now();
        sched.trigger(&clock, Trigger::Remote { seq: 1 });
        let next = sched.trigger(&clock, Trigger::Local);
        assert_eq!(
            next,
            Some(after_tick + LOCAL_FLOOR),
            "mixed pending must use the smaller (Local) floor"
        );

        clock.advance(LOCAL_FLOOR);
        assert!(sched.try_begin_tick(&clock));
        sched.end_tick(&clock);
    }

    #[test]
    fn slow_tick_next_fire_at_least_15s_after_end() {
        let clock = FakeClock::new();
        let mut sched = SyncScheduler::new();

        sched.trigger(&clock, Trigger::Remote { seq: 1 });
        clock.advance(COALESCE_WINDOW);
        assert!(sched.try_begin_tick(&clock));

        // Triggers during the long tick must not be dropped.
        clock.advance(Duration::from_secs(10));
        sched.trigger(&clock, Trigger::Remote { seq: 2 });
        clock.advance(Duration::from_secs(10));
        let end = clock.now();
        let next = sched.end_tick(&clock);
        assert_eq!(next, Some(end + REMOTE_FLOOR));

        clock.advance(Duration::from_secs(14));
        assert!(!sched.try_begin_tick(&clock));

        clock.advance(Duration::from_secs(1));
        assert!(sched.try_begin_tick(&clock));
        sched.end_tick(&clock);
    }
}
