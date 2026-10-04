'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { MINUTE, MAX_DURATION_MS } = require('./duration');
const { sanitizeRule } = require('./triggers');

const DEFAULT_PRESETS_MIN = [15, 30, 60, 120, 240, 480];

const DEFAULTS = Object.freeze({
  launchAtLogin: false,
  startSessionAtLaunch: false,
  /** Duration used by "Start Session" and the hotkey; null = until stopped. */
  defaultDurationMs: null,
  /** Keep the system awake but let the display sleep. */
  allowDisplaySleep: false,
  /** End the session on battery power below this %. 0 = off. */
  batteryCutoffPercent: 0,
  notifyOnEnd: true,
  showCountdownInMenuBar: true,
  /** Electron accelerator, e.g. "CommandOrControl+Alt+W". '' = none. */
  toggleShortcut: '',
  durationPresetsMin: DEFAULT_PRESETS_MIN,
  triggers: [],
});

/** Coerce arbitrary input into a valid settings object; unknown keys are dropped. */
function sanitize(raw, base = DEFAULTS) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...base };

  for (const key of ['launchAtLogin', 'startSessionAtLaunch', 'allowDisplaySleep', 'notifyOnEnd', 'showCountdownInMenuBar']) {
    if (typeof src[key] === 'boolean') out[key] = src[key];
  }

  if (src.defaultDurationMs === null) {
    out.defaultDurationMs = null;
  } else if (Number.isFinite(src.defaultDurationMs) && src.defaultDurationMs >= MINUTE && src.defaultDurationMs <= MAX_DURATION_MS) {
    out.defaultDurationMs = Math.round(src.defaultDurationMs);
  }

  if (Number.isFinite(src.batteryCutoffPercent)) {
    out.batteryCutoffPercent = Math.min(100, Math.max(0, Math.round(src.batteryCutoffPercent)));
  }

  if (typeof src.toggleShortcut === 'string') {
    out.toggleShortcut = src.toggleShortcut.trim().slice(0, 80);
  }

  if (Array.isArray(src.durationPresetsMin)) {
    const presets = src.durationPresetsMin
      .filter((m) => Number.isFinite(m) && m >= 1 && m <= MAX_DURATION_MS / MINUTE)
      .map((m) => Math.round(m));
    const unique = [...new Set(presets)].sort((a, b) => a - b).slice(0, 12);
    if (unique.length > 0) out.durationPresetsMin = unique;
  }

  if (Array.isArray(src.triggers)) {
    out.triggers = src.triggers.map(sanitizeRule).filter(Boolean).slice(0, 50);
  }

  return out;
}

/** JSON-file backed settings. Writes are atomic (temp file + rename). */
class SettingsStore extends EventEmitter {
  constructor(filePath) {
    super();
    this._file = filePath;
    this._values = { ...DEFAULTS };
  }

  load() {
    try {
      this._values = sanitize(JSON.parse(fs.readFileSync(this._file, 'utf8')));
    } catch {
      this._values = { ...DEFAULTS }; // missing or corrupt file: start fresh
    }
    return this.get();
  }

  get() {
    return JSON.parse(JSON.stringify(this._values));
  }

  /** Merge a partial update. Returns the new full settings. */
  update(patch) {
    this._values = sanitize(patch, this._values);
    this._save();
    const snapshot = this.get();
    this.emit('change', snapshot);
    return snapshot;
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      const tmp = `${this._file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this._values, null, 2));
      fs.renameSync(tmp, this._file);
    } catch (err) {
      this.emit('save-error', err); // not 'error': that would throw without a listener
    }
  }
}

module.exports = { SettingsStore, DEFAULTS, sanitize };
