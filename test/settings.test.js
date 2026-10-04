'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore, DEFAULTS, sanitize } = require('../src/core/settings');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeful-'));
  return { dir, file: path.join(dir, 'nested', 'settings.json') };
}

test('defaults when file is missing or corrupt', () => {
  const { dir, file } = tmpFile();
  const store = new SettingsStore(file);
  assert.deepEqual(store.load(), DEFAULTS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(store.load(), DEFAULTS);
  fs.rmSync(dir, { recursive: true });
});

test('update persists, merges, and emits change', () => {
  const { dir, file } = tmpFile();
  const store = new SettingsStore(file);
  store.load();
  let changes = 0;
  store.on('change', () => changes++);
  store.update({ allowDisplaySleep: true });
  store.update({ batteryCutoffPercent: 15 });
  assert.equal(changes, 2);
  const reloaded = new SettingsStore(file).load();
  assert.equal(reloaded.allowDisplaySleep, true);
  assert.equal(reloaded.batteryCutoffPercent, 15);
  assert.equal(reloaded.notifyOnEnd, true, 'untouched keys keep defaults');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'], 'no temp files left behind');
  fs.rmSync(dir, { recursive: true });
});

test('sanitize drops junk and clamps values', () => {
  const s = sanitize({
    launchAtLogin: 'yes', allowDisplaySleep: true, evil: 1,
    batteryCutoffPercent: 250, defaultDurationMs: 5, toggleShortcut: '  Ctrl+X  ',
    durationPresetsMin: [60, 15, 15, -3, 'x', 99999999],
    triggers: [{ type: 'app', name: 'Xcode' }, { type: 'bogus' }, 'str'],
  });
  assert.equal(s.launchAtLogin, false);
  assert.equal(s.allowDisplaySleep, true);
  assert.equal('evil' in s, false);
  assert.equal(s.batteryCutoffPercent, 100);
  assert.equal(s.defaultDurationMs, null, 'under one minute is rejected');
  assert.equal(s.toggleShortcut, 'Ctrl+X');
  assert.deepEqual(s.durationPresetsMin, [15, 60]);
  assert.equal(s.triggers.length, 1);
  assert.equal(s.triggers[0].name, 'Xcode');
});

test('defaultDurationMs accepts null and valid values', () => {
  assert.equal(sanitize({ defaultDurationMs: 3600000 }).defaultDurationMs, 3600000);
  assert.equal(sanitize({ defaultDurationMs: null }, { ...DEFAULTS, defaultDurationMs: 3600000 }).defaultDurationMs, null);
});

test('write failure emits save-error instead of throwing', () => {
  const { dir } = tmpFile();
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const store = new SettingsStore(path.join(blocker, 'settings.json')); // parent is a file
  let err = null;
  store.on('save-error', (e) => { err = e; });
  store.update({ notifyOnEnd: false });
  assert.ok(err);
  fs.rmSync(dir, { recursive: true });
});
