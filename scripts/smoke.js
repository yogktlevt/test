'use strict';

/**
 * Runs the Electron smoke test (src/main/smoke.js) against a throwaway profile.
 *
 *   npm run smoke
 *   npm run smoke -- --screenshots=./shots
 *
 * On Linux without a display it runs under xvfb-run. A fresh --user-data-dir
 * means it never reads or modifies your real settings, and the wrapper (not the
 * app) deletes it afterwards because Chromium writes into it while shutting down.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const electron = require('electron'); // path to the binary
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeful-smoke-'));

const args = [root, '--smoke', `--user-data-dir=${profile}`, '--disable-gpu'];
if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
  args.unshift('--no-sandbox'); // Chromium refuses to sandbox as root
}
args.push(...process.argv.slice(2));

let command = electron;
let commandArgs = args;
if (process.platform === 'linux' && !process.env.DISPLAY) {
  command = 'xvfb-run';
  commandArgs = ['-a', electron, ...args];
}

const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
fs.rmSync(profile, { recursive: true, force: true });

if (result.error) {
  console.error(`Could not start ${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
