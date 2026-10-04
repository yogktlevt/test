'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMenuTemplate, statusLabel, trayTitle } = require('../src/main/tray-menu');
const { DEFAULTS } = require('../src/core/settings');

const idle = { active: false, origin: null, remainingMs: null, allowDisplaySleep: false };
const timed = { active: true, origin: 'manual', remainingMs: 3_725_000, allowDisplaySleep: false };

test('statusLabel', () => {
  assert.equal(statusLabel(idle), 'Sleep allowed');
  assert.equal(statusLabel(timed), 'Awake — 1:02:05 left');
  assert.equal(statusLabel({ ...timed, remainingMs: null }), 'Awake until you end the session');
  assert.equal(statusLabel({ ...timed, origin: 'trigger', remainingMs: null }), 'Awake while a trigger matches');
  assert.equal(statusLabel({ ...timed, allowDisplaySleep: true }), 'Awake — 1:02:05 left (display may sleep)');
});

test('trayTitle shows the countdown only for timed sessions when enabled', () => {
  assert.equal(trayTitle(timed, DEFAULTS), ' 1:02:05');
  assert.equal(trayTitle(idle, DEFAULTS), '');
  assert.equal(trayTitle({ ...timed, remainingMs: null }, DEFAULTS), '');
  assert.equal(trayTitle(timed, { ...DEFAULTS, showCountdownInMenuBar: false }), '');
});

function handlersSpy() {
  const calls = [];
  const h = {};
  for (const name of ['startDefault', 'start', 'stop', 'setAllowDisplaySleep', 'openPreferences', 'quit']) {
    h[name] = (...args) => calls.push([name, ...args]);
  }
  return { h, calls };
}

test('idle menu offers Start Session and wires handlers', () => {
  const { h, calls } = handlersSpy();
  const menu = buildMenuTemplate({ session: idle, settings: DEFAULTS, handlers: h });
  const labels = menu.filter((i) => i.label).map((i) => i.label);
  assert.deepEqual(labels, ['Sleep allowed', 'Start Session', 'Start Session For', 'Allow Display Sleep', 'Triggers…', 'Preferences…', 'Quit Wakeful']);

  menu.find((i) => i.label === 'Start Session').click();
  const sub = menu.find((i) => i.label === 'Start Session For').submenu;
  sub.find((i) => i.label === '1 hour').click();
  sub.find((i) => i.label === 'Until I End It').click();
  sub.find((i) => i.label === 'Custom…').click();
  menu.find((i) => i.label === 'Allow Display Sleep').click({ checked: true });
  menu.find((i) => i.label === 'Quit Wakeful').click();
  assert.deepEqual(calls, [
    ['startDefault'], ['start', 3_600_000], ['start', null], ['openPreferences', 'session'],
    ['setAllowDisplaySleep', true], ['quit'],
  ]);
});

test('active menu offers End Session; default duration shows in the idle label', () => {
  const { h, calls } = handlersSpy();
  const menu = buildMenuTemplate({ session: timed, settings: DEFAULTS, handlers: h });
  assert.equal(menu.some((i) => i.label === 'Start Session'), false);
  menu.find((i) => i.label === 'End Session').click();
  assert.deepEqual(calls, [['stop']]);

  const withDefault = buildMenuTemplate({ session: idle, settings: { ...DEFAULTS, defaultDurationMs: 7_200_000 }, handlers: h });
  assert.ok(withDefault.some((i) => i.label === 'Start Session (2 hours)'));
});

test('display-sleep checkbox reflects the session when active, settings otherwise', () => {
  const { h } = handlersSpy();
  const find = (m) => m.find((i) => i.type === 'checkbox').checked;
  assert.equal(find(buildMenuTemplate({ session: idle, settings: { ...DEFAULTS, allowDisplaySleep: true }, handlers: h })), true);
  assert.equal(find(buildMenuTemplate({ session: { ...timed, allowDisplaySleep: false }, settings: { ...DEFAULTS, allowDisplaySleep: true }, handlers: h })), false);
});
