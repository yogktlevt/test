'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../src/core/system');

test('parsePs / parseTasklist', () => {
  assert.deepEqual(S.parsePs('/sbin/launchd\n\n  /usr/bin/foo \n'), ['/sbin/launchd', '/usr/bin/foo']);
  assert.deepEqual(S.parseTasklist('"System","4","Services","0","148 K"\r\n"zoom.exe","123","Console","1","5 K"\r\n'), ['System', 'zoom.exe']);
});

test('listProcesses uses the right command per platform and survives failure', async () => {
  const seen = [];
  const exec = (cmd, args, opts, cb) => { seen.push(cmd); cb(null, cmd === 'ps' ? 'a\nb\n' : '"c.exe","1"\n'); };
  assert.deepEqual(await S.listProcesses('linux', exec), ['a', 'b']);
  assert.deepEqual(await S.listProcesses('win32', exec), ['c.exe']);
  assert.deepEqual(seen, ['ps', 'tasklist']);
  const failing = (cmd, args, opts, cb) => cb(new Error('boom'));
  assert.deepEqual(await S.listProcesses('darwin', failing), []);
});

test('suggestAppNames prefers .app bundle names and dedupes', () => {
  const names = S.suggestAppNames([
    '/Applications/Xcode.app/Contents/MacOS/Xcode',
    '/Applications/Xcode.app/Contents/SharedFrameworks/Helper',
    '/usr/bin/ssh',
    'C:\\x\\Zoom.exe',
    '-zsh',
  ]);
  assert.deepEqual(names, ['ssh', 'Xcode', 'Zoom']);
});

test('parsePmset', () => {
  const battery = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t54%; discharging; 3:20 remaining present: true\n";
  assert.deepEqual(S.parsePmset(battery), { hasBattery: true, onBattery: true, percent: 54 });
  const ac = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n";
  assert.deepEqual(S.parsePmset(ac), { hasBattery: true, onBattery: false, percent: 100 });
  const desktop = "Now drawing from 'AC Power'\n";
  assert.deepEqual(S.parsePmset(desktop), { hasBattery: false, onBattery: false, percent: null });
  assert.deepEqual(S.parsePmset(''), { hasBattery: false, onBattery: false, percent: null });
});

test('readSysfsBattery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysfs-'));
  const put = (dir, file, val) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, file), `${val}\n`);
  };
  assert.equal(S.readSysfsBattery(root).hasBattery, false);
  put('AC', 'type', 'Mains');
  put('hidpp_battery_0', 'type', 'Battery'); put('hidpp_battery_0', 'scope', 'Device'); put('hidpp_battery_0', 'capacity', '90');
  assert.equal(S.readSysfsBattery(root).hasBattery, false, 'peripheral batteries are ignored');
  put('BAT0', 'type', 'Battery'); put('BAT0', 'capacity', '37'); put('BAT0', 'status', 'Discharging');
  assert.deepEqual(S.readSysfsBattery(root), { hasBattery: true, onBattery: true, percent: 37 });
  put('BAT0', 'status', 'Charging');
  assert.equal(S.readSysfsBattery(root).onBattery, false);
  assert.equal(S.readSysfsBattery(path.join(root, 'missing')).hasBattery, false);
  fs.rmSync(root, { recursive: true });
});

test('parseWin32Battery', () => {
  assert.deepEqual(S.parseWin32Battery('{"EstimatedChargeRemaining":62,"BatteryStatus":1}'), { hasBattery: true, onBattery: true, percent: 62 });
  assert.deepEqual(S.parseWin32Battery('[{"EstimatedChargeRemaining":99,"BatteryStatus":2}]'), { hasBattery: true, onBattery: false, percent: 99 });
  assert.equal(S.parseWin32Battery('').hasBattery, false);
  assert.equal(S.parseWin32Battery('garbage').hasBattery, false);
});

test('getBatteryInfo dispatches by platform', async () => {
  const exec = (cmd, args, opts, cb) => cb(null, "Now drawing from 'Battery Power'\n 10%; discharging");
  assert.equal((await S.getBatteryInfo('darwin', exec)).percent, 10);
  assert.equal((await S.getBatteryInfo('freebsd', exec)).hasBattery, false);
});
