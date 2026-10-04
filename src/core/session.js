'use strict';

const { EventEmitter } = require('node:events');
const { MAX_DURATION_MS } = require('./duration');

// setTimeout silently fires immediately above this, so long waits are chunked.
const MAX_TIMER_MS = 2 ** 31 - 1;

const BLOCK_SYSTEM = 'prevent-app-suspension';
const BLOCK_DISPLAY = 'prevent-display-sleep';

/**
 * Owns the single "keep awake" session.
 *
 * The OS-level blocker is injected (`{ start(type) -> id, stop(id) }`, the
 * shape of Electron's powerSaveBlocker) so this class has no Electron
 * dependency and can be tested with fakes.
 *
 * Events:
 *   'change' (state)           any state change
 *   'ended'  (reason, state)   session finished; reason is one of
 *                              'manual' | 'expired' | 'trigger' | 'battery'
 */
class SessionManager extends EventEmitter {
  constructor({ blocker, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    super();
    this._blocker = blocker;
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._timer = null;
    this._blockerId = null;
    this._state = idleState();
  }

  /** A snapshot; safe to hand to the UI. */
  get state() {
    return { ...this._state };
  }

  get active() {
    return this._state.active;
  }

  /**
   * Start (or replace) a session.
   * @param {object} [opts]
   * @param {number|null} [opts.durationMs]   null = until stopped
   * @param {boolean} [opts.allowDisplaySleep] keep the system awake but let the screen sleep
   * @param {'manual'|'trigger'} [opts.origin]
   */
  start({ durationMs = null, allowDisplaySleep = false, origin = 'manual' } = {}) {
    if (durationMs !== null) {
      if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) {
        throw new RangeError(`durationMs must be between 1 and ${MAX_DURATION_MS}`);
      }
    }
    const startedAt = this._now();
    this._releaseBlocker();
    this._clearTimeout();

    this._state = {
      active: true,
      origin,
      startedAt,
      endsAt: durationMs === null ? null : startedAt + durationMs,
      allowDisplaySleep: Boolean(allowDisplaySleep),
    };
    this._acquireBlocker();
    this._arm();
    this.emit('change', this.state);
  }

  /** End the session. No-op if none is active. */
  stop(reason = 'manual') {
    if (!this._state.active) return;
    this._releaseBlocker();
    this._clearTimeout();
    this._state = idleState();
    this.emit('change', this.state);
    this.emit('ended', reason, this.state);
  }

  /** Switch between "keep display on" and "let display sleep" mid-session. */
  setAllowDisplaySleep(allow) {
    if (!this._state.active || this._state.allowDisplaySleep === Boolean(allow)) return;
    this._releaseBlocker();
    this._state = { ...this._state, allowDisplaySleep: Boolean(allow) };
    this._acquireBlocker();
    this.emit('change', this.state);
  }

  /** Milliseconds left, or null for an open-ended or inactive session. */
  remainingMs() {
    if (!this._state.active || this._state.endsAt === null) return null;
    return Math.max(0, this._state.endsAt - this._now());
  }

  /** Release the OS blocker without emitting; for app shutdown. */
  dispose() {
    this._releaseBlocker();
    this._clearTimeout();
    this._state = idleState();
  }

  _acquireBlocker() {
    const type = this._state.allowDisplaySleep ? BLOCK_SYSTEM : BLOCK_DISPLAY;
    this._blockerId = this._blocker.start(type);
  }

  _releaseBlocker() {
    if (this._blockerId !== null) {
      this._blocker.stop(this._blockerId);
      this._blockerId = null;
    }
  }

  _arm() {
    if (this._state.endsAt === null) return;
    const remaining = this._state.endsAt - this._now();
    this._timer = this._setTimer(() => {
      this._timer = null;
      // Timers can fire early (clock changes, chunked waits) — re-check.
      if (this._state.endsAt !== null && this._now() < this._state.endsAt) {
        this._arm();
      } else {
        this.stop('expired');
      }
    }, Math.min(Math.max(remaining, 0), MAX_TIMER_MS));
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  _clearTimeout() {
    if (this._timer !== null) {
      this._clearTimer(this._timer);
      this._timer = null;
    }
  }
}

function idleState() {
  return { active: false, origin: null, startedAt: null, endsAt: null, allowDisplaySleep: false };
}

module.exports = { SessionManager, BLOCK_SYSTEM, BLOCK_DISPLAY };
