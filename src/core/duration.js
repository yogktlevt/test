'use strict';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Longest single session we accept. Keeps timers and the UI sane.
const MAX_DURATION_MS = 7 * DAY;

/**
 * Parse a human duration into milliseconds.
 *
 * Accepts "45", "45m", "2h", "1h30m", "1.5h", "90 min", "1:30" (h:mm) and
 * "1:30:15" (h:mm:ss). A bare number is minutes. Returns null if invalid or
 * out of range (<= 0 or > MAX_DURATION_MS).
 */
function parseDuration(input) {
  if (typeof input === 'number') {
    return clamp(Math.round(input * MINUTE));
  }
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;

  const clock = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s);
  if (clock) {
    const [, h, m, sec] = clock;
    return clamp(Number(h) * HOUR + Number(m) * MINUTE + Number(sec || 0) * 1000);
  }

  if (/^\d+(\.\d+)?$/.test(s)) {
    return clamp(Math.round(Number(s) * MINUTE));
  }

  // One or more "<number><unit>" parts, e.g. "1h30m" or "2 hours 15 min".
  if (!/^(?:\d+(?:\.\d+)?\s*[dhms][a-z]*\s*)+$/.test(s)) return null;

  const unit = /(\d+(?:\.\d+)?)\s*([dhms])[a-z]*/g;
  let total = 0;
  let match;
  while ((match = unit.exec(s)) !== null) {
    const value = Number(match[1]);
    switch (match[2]) {
      case 'd': total += value * DAY; break;
      case 'h': total += value * HOUR; break;
      case 'm': total += value * MINUTE; break;
      case 's': total += value * 1000; break;
    }
  }
  return clamp(Math.round(total));
}

function clamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_DURATION_MS) return null;
  return ms;
}

/** "1:23:45" for >= 1h, otherwise "12:05". Rounds up so 0:00 is never shown while active. */
function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "15 minutes", "1 hour", "1 hour 30 minutes", "2 days". */
function formatDuration(ms) {
  const totalMinutes = Math.round(ms / MINUTE);
  if (totalMinutes < 1) return `${Math.round(ms / 1000)} seconds`;
  const d = Math.floor(totalMinutes / (24 * 60));
  const h = Math.floor((totalMinutes % (24 * 60)) / 60);
  const m = totalMinutes % 60;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [];
  if (d) parts.push(plural(d, 'day'));
  if (h) parts.push(plural(h, 'hour'));
  if (m) parts.push(plural(m, 'minute'));
  return parts.join(' ');
}

/**
 * Milliseconds from `now` until the next occurrence of a wall-clock time
 * ("HH:MM", 24h). If that time is now or already passed today, it means
 * tomorrow. Returns null for invalid input.
 */
function msUntilTimeOfDay(hhmm, now = new Date()) {
  const parsed = parseTimeOfDay(hhmm);
  if (!parsed) return null;
  const target = new Date(now);
  target.setHours(parsed.hours, parsed.minutes, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/** Parse "HH:MM" into { hours, minutes } or null. */
function parseTimeOfDay(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) return null;
  return { hours: Number(m[1]), minutes: Number(m[2]) };
}

module.exports = {
  MINUTE,
  HOUR,
  DAY,
  MAX_DURATION_MS,
  parseDuration,
  formatRemaining,
  formatDuration,
  msUntilTimeOfDay,
  parseTimeOfDay,
};
