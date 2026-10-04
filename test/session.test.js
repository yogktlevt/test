'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionManager } = require('../src/core/session');
const { makeClock, makeBlocker } = require('./helpers');

function setup() {
  const clock = makeClock();
  const blocker = makeBlocker();
  const session = new SessionManager({ blocker, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { clock, blocker, session };
}

test('starts idle', () => {
  const { session } = setup();
  assert.equal(session.active, false);
  assert.equal(session.remainingMs(), null);
});

test('open-ended session blocks display sleep by default and stops manually', () => {
  const { session, blocker, clock } = setup();
  const ended = [];
  session.on('ended', (r) => ended.push(r));
  session.start();
  assert.deepEqual(blocker.liveTypes(), ['prevent-display-sleep']);
  assert.equal(session.state.endsAt, null);
  assert.equal(clock.pending(), 0);
  session.stop();
  assert.deepEqual(blocker.liveTypes(), []);
  assert.deepEqual(ended, ['manual']);
  assert.equal(session.active, false);
});

test('allowDisplaySleep uses the system-only blocker', () => {
  const { session, blocker } = setup();
  session.start({ allowDisplaySleep: true });
  assert.deepEqual(blocker.liveTypes(), ['prevent-app-suspension']);
});

test('timed session expires and releases the blocker', () => {
  const { session, blocker, clock } = setup();
  const ended = [];
  session.on('ended', (r) => ended.push(r));
  session.start({ durationMs: 60_000 });
  assert.equal(session.remainingMs(), 60_000);
  clock.advance(59_999);
  assert.equal(session.active, true);
  assert.equal(session.remainingMs(), 1);
  clock.advance(1);
  assert.equal(session.active, false);
  assert.deepEqual(blocker.liveTypes(), []);
  assert.deepEqual(ended, ['expired']);
});

test('starting a new session replaces the old one without leaking blockers', () => {
  const { session, blocker, clock } = setup();
  const ended = [];
  session.on('ended', (r) => ended.push(r));
  session.start({ durationMs: 60_000 });
  session.start({ durationMs: 120_000 });
  assert.equal(blocker.liveTypes().length, 1);
  assert.equal(clock.pending(), 1);
  assert.deepEqual(ended, []); // replacement is not an "end"
  clock.advance(60_000);
  assert.equal(session.active, true);
  clock.advance(60_000);
  assert.equal(session.active, false);
});

test('setAllowDisplaySleep swaps the blocker type mid-session', () => {
  const { session, blocker } = setup();
  session.start({ durationMs: 60_000 });
  session.setAllowDisplaySleep(true);
  assert.deepEqual(blocker.liveTypes(), ['prevent-app-suspension']);
  assert.equal(session.state.allowDisplaySleep, true);
  session.setAllowDisplaySleep(true); // no-op
  assert.deepEqual(blocker.log, ['start:prevent-display-sleep', 'stop:prevent-display-sleep', 'start:prevent-app-suspension']);
});

test('timer that fires early re-arms instead of ending the session', () => {
  const clock = makeClock();
  const blocker = makeBlocker();
  const fns = [];
  const session = new SessionManager({
    blocker, now: clock.now, clearTimer: () => {},
    setTimer: (fn) => { fns.push(fn); return fns.length; },
  });
  session.start({ durationMs: 10_000 });
  fns[0](); // fires with no time having passed
  assert.equal(session.active, true);
  assert.equal(fns.length, 2); // re-armed
  clock.advance(10_000);
  fns[1]();
  assert.equal(session.active, false);
});

test('rejects invalid durations', () => {
  const { session } = setup();
  for (const bad of [0, -1, NaN, Infinity, 1e12]) {
    assert.throws(() => session.start({ durationMs: bad }), RangeError);
  }
  assert.equal(session.active, false);
});

test('stop when idle is a no-op; dispose releases silently', () => {
  const { session, blocker } = setup();
  const events = [];
  session.on('ended', () => events.push('ended'));
  session.stop();
  assert.deepEqual(events, []);
  session.start();
  session.dispose();
  assert.deepEqual(blocker.liveTypes(), []);
  assert.deepEqual(events, []);
});

test('emits change events', () => {
  const { session } = setup();
  const states = [];
  session.on('change', (s) => states.push(s.active));
  session.start();
  session.stop();
  assert.deepEqual(states, [true, false]);
});
