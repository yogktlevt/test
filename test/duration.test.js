'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/core/duration');

test('parseDuration accepts common formats', () => {
  assert.equal(d.parseDuration('45'), 45 * d.MINUTE);
  assert.equal(d.parseDuration('45m'), 45 * d.MINUTE);
  assert.equal(d.parseDuration('2h'), 2 * d.HOUR);
  assert.equal(d.parseDuration('1h30m'), 90 * d.MINUTE);
  assert.equal(d.parseDuration('1.5h'), 90 * d.MINUTE);
  assert.equal(d.parseDuration('2 hours 15 min'), 135 * d.MINUTE);
  assert.equal(d.parseDuration('1:30'), 90 * d.MINUTE);
  assert.equal(d.parseDuration('1:30:15'), 90 * d.MINUTE + 15000);
  assert.equal(d.parseDuration('  3D '), 3 * d.DAY);
  assert.equal(d.parseDuration(15), 15 * d.MINUTE);
});

test('parseDuration rejects bad or out-of-range input', () => {
  for (const bad of ['', '  ', 'abc', '2h banana', 'h', '0', '0m', '-5', '8d', '1:75', null, undefined, {}, NaN, 0, -3]) {
    assert.equal(d.parseDuration(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('formatRemaining', () => {
  assert.equal(d.formatRemaining(0), '0:00');
  assert.equal(d.formatRemaining(1), '0:01'); // rounds up
  assert.equal(d.formatRemaining(65_000), '1:05');
  assert.equal(d.formatRemaining(3_600_000), '1:00:00');
  assert.equal(d.formatRemaining(3_725_000), '1:02:05');
  assert.equal(d.formatRemaining(-50), '0:00');
});

test('formatDuration', () => {
  assert.equal(d.formatDuration(15 * d.MINUTE), '15 minutes');
  assert.equal(d.formatDuration(d.HOUR), '1 hour');
  assert.equal(d.formatDuration(90 * d.MINUTE), '1 hour 30 minutes');
  assert.equal(d.formatDuration(2 * d.DAY), '2 days');
  assert.equal(d.formatDuration(20_000), '20 seconds');
});

test('msUntilTimeOfDay picks the next occurrence', () => {
  const now = new Date(2025, 0, 15, 10, 0, 0, 0);
  assert.equal(d.msUntilTimeOfDay('17:30', now), 7.5 * d.HOUR);
  assert.equal(d.msUntilTimeOfDay('09:00', now), 23 * d.HOUR); // tomorrow
  assert.equal(d.msUntilTimeOfDay('10:00', now), 24 * d.HOUR); // exactly now -> tomorrow
  assert.equal(d.msUntilTimeOfDay('25:00', now), null);
  assert.equal(d.msUntilTimeOfDay('nope', now), null);
});
