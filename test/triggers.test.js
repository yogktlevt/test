'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/core/triggers');
const { SessionManager } = require('../src/core/session');
const { BatteryGuard } = require('../src/core/battery-guard');
const { makeClock, makeBlocker } = require('./helpers');

test('sanitizeRule validates each rule type', () => {
  assert.equal(T.sanitizeRule(null), null);
  assert.equal(T.sanitizeRule({ type: 'nope' }), null);
  assert.equal(T.sanitizeRule({ type: 'app', name: '   ' }), null);

  const app = T.sanitizeRule({ type: 'app', name: ' Xcode ' });
  assert.equal(app.name, 'Xcode');
  assert.equal(app.enabled, true);
  assert.ok(app.id);

  assert.equal(T.sanitizeRule({ type: 'power', enabled: false }).enabled, false);

  assert.equal(T.sanitizeRule({ type: 'schedule', days: [1], start: '9:00', end: '9:00' }), null);
  assert.equal(T.sanitizeRule({ type: 'schedule', days: [], start: '09:00', end: '17:00' }), null);
  assert.equal(T.sanitizeRule({ type: 'schedule', days: [9], start: '09:00', end: '17:00' }), null);
  assert.equal(T.sanitizeRule({ type: 'schedule', days: [1], start: '25:00', end: '17:00' }), null);
  const sched = T.sanitizeRule({ type: 'schedule', days: [5, 1, 1], start: '9:00', end: '17:30' });
  assert.deepEqual(sched.days, [1, 5]);
  assert.equal(sched.start, '09:00');
});

test('describeRule', () => {
  assert.equal(T.describeRule({ type: 'app', name: 'Zoom' }), 'While Zoom is running');
  assert.equal(T.describeRule({ type: 'power' }), 'While on AC power');
  assert.equal(T.describeRule({ type: 'schedule', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }), 'Weekdays, 09:00–17:00');
});

test('appIsRunning matches names, paths and .app bundles case-insensitively', () => {
  const procs = [
    '/Applications/Xcode.app/Contents/MacOS/Xcode',
    '/Applications/Google Chrome.app/Contents/Frameworks/Helper',
    '/usr/sbin/cfprefsd',
    'C:\\Program Files\\Zoom\\Zoom.exe',
    'node',
  ];
  assert.equal(T.appIsRunning('xcode', procs), true);
  assert.equal(T.appIsRunning('Google Chrome', procs), true); // via bundle path
  assert.equal(T.appIsRunning('zoom.exe', procs), true);
  assert.equal(T.appIsRunning('Zoom', procs), true);
  assert.equal(T.appIsRunning('node', procs), true);
  assert.equal(T.appIsRunning('cfpref', procs), false); // no substring matching
  assert.equal(T.appIsRunning('Slack', procs), false);
  assert.equal(T.appIsRunning('', procs), false);
});

test('scheduleActive handles same-day and overnight windows', () => {
  const weekday = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };
  const mon = (h, m) => new Date(2025, 0, 13, h, m); // Monday
  const sat = (h, m) => new Date(2025, 0, 18, h, m);
  assert.equal(T.scheduleActive(weekday, mon(9, 0)), true);
  assert.equal(T.scheduleActive(weekday, mon(16, 59)), true);
  assert.equal(T.scheduleActive(weekday, mon(17, 0)), false);
  assert.equal(T.scheduleActive(weekday, mon(8, 59)), false);
  assert.equal(T.scheduleActive(weekday, sat(12, 0)), false);

  const night = { days: [5], start: '22:00', end: '06:00' }; // Friday night
  const fri = (h, m) => new Date(2025, 0, 17, h, m);
  assert.equal(T.scheduleActive(night, fri(23, 0)), true);
  assert.equal(T.scheduleActive(night, sat(5, 59)), true); // still Friday's window
  assert.equal(T.scheduleActive(night, sat(6, 0)), false);
  assert.equal(T.scheduleActive(night, fri(5, 0)), false); // Thursday night's window, not enabled
});

function engineWith(over = {}) {
  const calls = { processes: 0, power: 0 };
  const engine = new T.TriggerEngine({
    processes: async () => { calls.processes++; return over.processes || []; },
    onAcPower: async () => { calls.power++; return over.ac ?? true; },
    now: () => over.now || new Date(2025, 0, 13, 10, 0),
  });
  return { engine, calls };
}

test('engine skips disabled rules and only probes what it needs', async () => {
  const { engine, calls } = engineWith({ processes: ['Xcode'] });
  const none = await engine.evaluate([{ id: 'a', type: 'app', name: 'Xcode', enabled: false }]);
  assert.deepEqual(none, { satisfied: false, matched: [] });
  assert.deepEqual(calls, { processes: 0, power: 0 });

  const res = await engine.evaluate([
    { id: 'a', type: 'app', name: 'Xcode', enabled: true },
    { id: 'b', type: 'app', name: 'Slack', enabled: true },
  ]);
  assert.deepEqual(res, { satisfied: true, matched: ['a'] });
  assert.equal(calls.power, 0);
});

test('engine: power and schedule rules', async () => {
  const { engine } = engineWith({ ac: false });
  const rules = [
    { id: 'p', type: 'power', enabled: true },
    { id: 's', type: 'schedule', enabled: true, days: [1], start: '09:00', end: '17:00' },
  ];
  assert.deepEqual((await engine.evaluate(rules)).matched, ['s']);
});

function controllerSetup(initialProcesses) {
  const clock = makeClock();
  const blocker = makeBlocker();
  const session = new SessionManager({ blocker, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const world = { processes: initialProcesses };
  const engine = new T.TriggerEngine({ processes: async () => world.processes, onAcPower: async () => true, now: () => new Date() });
  const rules = [{ id: 'x', type: 'app', name: 'Xcode', enabled: true }];
  const controller = new T.TriggerController({
    session, engine, getRules: () => rules, getSessionOptions: () => ({ allowDisplaySleep: false }),
  });
  return { session, controller, world, blocker };
}

test('controller starts a session when a rule matches and stops it when it clears', async () => {
  const { session, controller, world } = controllerSetup(['Xcode']);
  await controller.tick();
  assert.equal(session.active, true);
  assert.equal(session.state.origin, 'trigger');
  world.processes = [];
  await controller.tick();
  assert.equal(session.active, false);
});

test('controller never touches a manual session', async () => {
  const { session, controller, world } = controllerSetup([]);
  session.start({ origin: 'manual' });
  await controller.tick(); // rules unsatisfied
  assert.equal(session.active, true);
  world.processes = ['Xcode'];
  await controller.tick(); // satisfied, but a session already runs
  assert.equal(session.state.origin, 'manual');
});

test('after the user ends a trigger session, it stays off until the condition clears', async () => {
  const { session, controller, world } = controllerSetup(['Xcode']);
  await controller.tick();
  session.stop('manual');
  await controller.tick();
  assert.equal(session.active, false, 'must not restart immediately');
  world.processes = [];
  await controller.tick();
  world.processes = ['Xcode'];
  await controller.tick();
  assert.equal(session.active, true, 'restarts after condition went false then true');
});

test('battery guard ends sessions at or below the cutoff, on battery only', async () => {
  const clock = makeClock();
  const session = new SessionManager({ blocker: makeBlocker(), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const ended = [];
  session.on('ended', (r) => ended.push(r));
  let battery = { hasBattery: true, onBattery: true, percent: 40 };
  let probes = 0;
  let cutoff = 20;
  const guard = new BatteryGuard({ session, getBattery: async () => { probes++; return battery; }, getCutoff: () => cutoff });

  assert.equal(await guard.tick(), false);
  assert.equal(probes, 0, 'no probe while idle');

  session.start();
  assert.equal(await guard.tick(), false); // 40% > 20%
  battery = { hasBattery: true, onBattery: false, percent: 5 };
  assert.equal(await guard.tick(), false); // plugged in
  battery = { hasBattery: true, onBattery: true, percent: 20 };
  cutoff = 0;
  assert.equal(await guard.tick(), false); // disabled
  cutoff = 20;
  assert.equal(await guard.tick(), true);
  assert.deepEqual(ended, ['battery']);
  assert.equal(session.active, false);
});

test('a battery-ended trigger session is not restarted immediately', async () => {
  const { session, controller, world } = controllerSetup(['Xcode']);
  await controller.tick();
  session.stop('battery');
  await controller.tick();
  assert.equal(session.active, false);
});
