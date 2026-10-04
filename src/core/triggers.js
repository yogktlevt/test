'use strict';

const crypto = require('node:crypto');
const { parseTimeOfDay } = require('./duration');

const RULE_TYPES = ['app', 'power', 'schedule'];

/**
 * Trigger rules start a session automatically while a condition holds:
 *   { type: 'app',      name: 'Xcode' }                     an app/process is running
 *   { type: 'power' }                                         the computer is on AC power
 *   { type: 'schedule', days: [1,2,3,4,5], start: '09:00', end: '17:00' }
 * Every rule also has `id` and `enabled`.
 */

/** Validate and normalise untrusted input; returns a clean rule or null. */
function sanitizeRule(raw) {
  if (!raw || typeof raw !== 'object' || !RULE_TYPES.includes(raw.type)) return null;
  const rule = {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : crypto.randomUUID(),
    type: raw.type,
    enabled: raw.enabled !== false,
  };

  if (raw.type === 'app') {
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 200) : '';
    if (!name) return null;
    rule.name = name;
  } else if (raw.type === 'schedule') {
    if (!parseTimeOfDay(raw.start) || !parseTimeOfDay(raw.end) || raw.start === raw.end) return null;
    const days = Array.isArray(raw.days)
      ? [...new Set(raw.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : [];
    if (days.length === 0) return null;
    rule.days = days;
    rule.start = normaliseTime(raw.start);
    rule.end = normaliseTime(raw.end);
  }
  return rule;
}

function normaliseTime(hhmm) {
  const { hours, minutes } = parseTimeOfDay(hhmm);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Human-readable one-liner for the UI. */
function describeRule(rule) {
  switch (rule.type) {
    case 'app': return `While ${rule.name} is running`;
    case 'power': return 'While on AC power';
    case 'schedule': return `${dayList(rule.days)}, ${rule.start}–${rule.end}`;
    default: return 'Unknown trigger';
  }
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayList(days) {
  const key = days.join(',');
  if (key === '0,1,2,3,4,5,6') return 'Every day';
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  return days.map((d) => DAY_NAMES[d]).join(' ');
}

/** Does this process list contain an app matching `name`? */
function appIsRunning(name, processes) {
  const wanted = normaliseProcessName(name);
  if (!wanted) return false;
  const bundle = `/${wanted}.app/`;
  return processes.some((proc) => {
    const lower = proc.toLowerCase();
    return normaliseProcessName(proc) === wanted || lower.includes(bundle);
  });
}

/** Last path segment, minus ".exe" / ".app", lowercased. */
function normaliseProcessName(value) {
  const base = String(value).trim().split(/[\\/]/).pop().toLowerCase();
  return base.replace(/\.(exe|app)$/, '');
}

/** Is `date` inside the schedule's window? Windows may cross midnight. */
function scheduleActive(rule, date) {
  const start = parseTimeOfDay(rule.start);
  const end = parseTimeOfDay(rule.end);
  if (!start || !end) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  const from = start.hours * 60 + start.minutes;
  const to = end.hours * 60 + end.minutes;
  const day = date.getDay();

  if (from < to) {
    return rule.days.includes(day) && minutes >= from && minutes < to;
  }
  // Overnight: the window belongs to the day it *started* on.
  if (minutes >= from) return rule.days.includes(day);
  if (minutes < to) return rule.days.includes((day + 6) % 7);
  return false;
}

/**
 * Evaluates rules against injected probes so tests need no real system.
 * Probes: { processes(): Promise<string[]>, onAcPower(): Promise<boolean>, now(): Date }
 */
class TriggerEngine {
  constructor(probes) {
    this._probes = probes;
  }

  /** @returns {Promise<{ satisfied: boolean, matched: string[] }>} ids of matching rules */
  async evaluate(rules) {
    const enabled = rules.filter((r) => r.enabled);
    if (enabled.length === 0) return { satisfied: false, matched: [] };

    const needsProcesses = enabled.some((r) => r.type === 'app');
    const needsPower = enabled.some((r) => r.type === 'power');
    const processes = needsProcesses ? await this._probes.processes() : [];
    const onAc = needsPower ? await this._probes.onAcPower() : false;
    const now = this._probes.now();

    const matched = [];
    for (const rule of enabled) {
      let ok = false;
      if (rule.type === 'app') ok = appIsRunning(rule.name, processes);
      else if (rule.type === 'power') ok = onAc;
      else if (rule.type === 'schedule') ok = scheduleActive(rule, now);
      if (ok) matched.push(rule.id);
    }
    return { satisfied: matched.length > 0, matched };
  }
}

/**
 * Starts/stops sessions in response to trigger results.
 *
 * - A trigger session only starts when no session is running, and only stops
 *   sessions it started itself; a manual session is never touched.
 * - If the user ends a trigger session by hand, triggers stay quiet until
 *   every condition has gone false once (so it does not instantly restart).
 */
class TriggerController {
  constructor({ session, engine, getRules, getSessionOptions }) {
    this._session = session;
    this._engine = engine;
    this._getRules = getRules;
    this._getSessionOptions = getSessionOptions;
    this._suppressed = false;
    this._lastOrigin = null;

    // 'ended' reports the post-stop (idle) state, so remember the origin from 'change'.
    session.on('change', (state) => {
      if (state.active) this._lastOrigin = state.origin;
    });
    session.on('ended', (reason) => {
      // Our own stop (reason 'trigger') must not suppress; the user's or battery's must.
      if (this._lastOrigin === 'trigger' && (reason === 'manual' || reason === 'battery')) {
        this._suppressed = true;
      }
      this._lastOrigin = null;
    });
  }

  /** Call periodically. Resolves to the evaluation result. */
  async tick() {
    const result = await this._engine.evaluate(this._getRules());
    const state = this._session.state;

    if (!result.satisfied) {
      this._suppressed = false;
      if (state.active && state.origin === 'trigger') this._session.stop('trigger');
    } else if (!state.active && !this._suppressed) {
      this._session.start({ ...this._getSessionOptions(), durationMs: null, origin: 'trigger' });
    }
    return result;
  }
}

module.exports = {
  RULE_TYPES,
  sanitizeRule,
  describeRule,
  appIsRunning,
  scheduleActive,
  TriggerEngine,
  TriggerController,
};
