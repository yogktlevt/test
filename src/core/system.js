'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** Run a command and resolve with stdout; resolve '' on any failure. */
function run(cmd, args, execImpl = execFile) {
  return new Promise((resolve) => {
    execImpl(cmd, args, { timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout));
    });
  });
}

/* ------------------------------ processes ------------------------------ */

/** Parse `ps -axo comm=` output (macOS/Linux): one command path per line. */
function parsePs(output) {
  return output.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Parse `tasklist /fo csv /nh` output (Windows): "name.exe","pid",... */
function parseTasklist(output) {
  const names = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.push(m[1]);
  }
  return names;
}

async function listProcesses(platform = process.platform, execImpl = execFile) {
  if (platform === 'win32') {
    return parseTasklist(await run('tasklist', ['/fo', 'csv', '/nh'], execImpl));
  }
  return parsePs(await run('ps', ['-axo', 'comm='], execImpl));
}

/** Distinct, sorted display names for UI suggestions (user-facing apps first on macOS). */
function suggestAppNames(processes) {
  const names = new Set();
  for (const proc of processes) {
    const bundle = /\/([^/]+)\.app\//.exec(proc);
    const base = proc.split(/[\\/]/).pop().replace(/\.exe$/i, '');
    const name = bundle ? bundle[1] : base;
    if (name && !name.startsWith('-')) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/* ------------------------------- battery ------------------------------- */

/**
 * @typedef {{ hasBattery: boolean, onBattery: boolean, percent: number|null }} BatteryInfo
 */
const NO_BATTERY = Object.freeze({ hasBattery: false, onBattery: false, percent: null });

/** macOS: `pmset -g batt`. */
function parsePmset(output) {
  const percent = /(\d{1,3})%/.exec(output);
  if (!percent) return { ...NO_BATTERY };
  return {
    hasBattery: true,
    onBattery: /Now drawing from 'Battery Power'/.test(output),
    percent: Math.min(100, Number(percent[1])),
  };
}

/** Linux: files under /sys/class/power_supply. */
function readSysfsBattery(root = '/sys/class/power_supply', fsImpl = fs) {
  let entries;
  try {
    entries = fsImpl.readdirSync(root);
  } catch {
    return { ...NO_BATTERY };
  }
  const read = (dir, file) => {
    try {
      return String(fsImpl.readFileSync(path.join(root, dir, file))).trim();
    } catch {
      return null;
    }
  };
  for (const dir of entries) {
    if (read(dir, 'type') !== 'Battery') continue;
    if (read(dir, 'scope') === 'Device') continue; // wireless mouse, etc.
    const capacity = Number(read(dir, 'capacity'));
    if (!Number.isFinite(capacity)) continue;
    return {
      hasBattery: true,
      onBattery: read(dir, 'status') === 'Discharging',
      percent: Math.min(100, Math.max(0, capacity)),
    };
  }
  return { ...NO_BATTERY };
}

/** Windows: JSON from `Get-CimInstance Win32_Battery` (an object, or an array for several). */
function parseWin32Battery(output) {
  let data;
  try {
    data = JSON.parse(output);
  } catch {
    return { ...NO_BATTERY };
  }
  const battery = Array.isArray(data) ? data[0] : data;
  if (!battery || !Number.isFinite(Number(battery.EstimatedChargeRemaining))) return { ...NO_BATTERY };
  return {
    hasBattery: true,
    // BatteryStatus 1 = discharging; 2 = on AC; 3+ = charged/charging/low-while-charging.
    onBattery: Number(battery.BatteryStatus) === 1,
    percent: Math.min(100, Math.max(0, Number(battery.EstimatedChargeRemaining))),
  };
}

/** @returns {Promise<BatteryInfo>} */
async function getBatteryInfo(platform = process.platform, execImpl = execFile, fsImpl = fs) {
  if (platform === 'darwin') return parsePmset(await run('pmset', ['-g', 'batt'], execImpl));
  if (platform === 'linux') return readSysfsBattery('/sys/class/power_supply', fsImpl);
  if (platform === 'win32') {
    const out = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress'],
      execImpl,
    );
    return parseWin32Battery(out);
  }
  return { ...NO_BATTERY };
}

module.exports = {
  listProcesses,
  suggestAppNames,
  parsePs,
  parseTasklist,
  getBatteryInfo,
  parsePmset,
  readSysfsBattery,
  parseWin32Battery,
};
