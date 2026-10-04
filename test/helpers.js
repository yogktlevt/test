'use strict';

/** Fake clock + timer queue so session tests are deterministic. */
function makeClock(start = 1_700_000_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    /** Advance time, firing due timers in order. */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

/** Records blocker start/stop calls like Electron's powerSaveBlocker. */
function makeBlocker() {
  let nextId = 1;
  const live = new Map();
  return {
    log: [],
    start(type) {
      const id = nextId++;
      live.set(id, type);
      this.log.push(`start:${type}`);
      return id;
    },
    stop(id) {
      this.log.push(`stop:${live.get(id)}`);
      live.delete(id);
    },
    liveTypes: () => [...live.values()],
  };
}

module.exports = { makeClock, makeBlocker };
