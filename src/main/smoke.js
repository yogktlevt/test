'use strict';

/**
 * End-to-end smoke test, run with `npm run smoke` (Electron under Xvfb).
 * Drives the real app: OS power blocker, tray, preferences UI over IPC, and a
 * trigger that matches a real process. Optionally saves screenshots:
 *
 *   npm run smoke -- --screenshots=/some/dir
 */

const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runSmoke({ session, settings, snapshot, openPreferences, getTray, powerSaveBlocker, buildMenuTemplate, poll }) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  };

  try {
    // 1. The OS-level blocker really starts and stops.
    session.start({ allowDisplaySleep: false });
    check('session holds an OS power blocker', powerSaveBlocker.isStarted(session._blockerId));
    session.setAllowDisplaySleep(true);
    check('switching to system-only keeps a blocker held', powerSaveBlocker.isStarted(session._blockerId));
    const heldId = session._blockerId;
    session.stop();
    check('stopping releases the blocker', !powerSaveBlocker.isStarted(heldId));

    // 2. Timed sessions expire on their own.
    session.start({ durationMs: 1000 });
    await sleep(1400);
    check('a 1s session expires by itself', !session.active);

    // 3. Tray + menu.
    const tray = getTray();
    check('tray icon exists', Boolean(tray) && !tray.isDestroyed());
    const menu = buildMenuTemplate({ session: snapshot().session, settings: snapshot().settings, handlers: {} });
    check('tray menu builds', menu.length > 5);

    // 4. Preferences UI over IPC.
    const win = openPreferences('session');
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    const ui = (js) => win.webContents.executeJavaScript(js);
    await sleep(300);

    check('renderer is isolated from Node', await ui('typeof require === "undefined" && typeof process === "undefined"'));
    check('preload bridge is exposed', await ui('typeof window.wakeful.start === "function"'));
    check('UI shows idle state', (await ui('document.getElementById("status-title").textContent')) === 'Sleep allowed');

    await shot(win, 'session-idle');

    await ui('[...document.querySelectorAll("#presets button")].find(b => b.textContent === "15 minutes").click()');
    await sleep(300);
    check('clicking a preset starts a 15-minute session', session.active && Math.abs(session.remainingMs() - 15 * 60_000) < 2000);
    check('UI shows countdown', /^1[45]:\d\d$/.test(await ui('document.getElementById("countdown").textContent')));
    await shot(win, 'session-active');

    await ui('document.getElementById("allow-display-sleep").click()');
    await sleep(200);
    check('display-sleep toggle updates session + settings', session.state.allowDisplaySleep === true && settings.get().allowDisplaySleep === true);

    await ui('document.getElementById("primary").click()');
    await sleep(200);
    check('End session button stops it', !session.active);

    await ui('document.getElementById("custom-duration").value = "banana"; document.getElementById("start-custom").click()');
    await sleep(200);
    check('bad custom duration shows an error and does not start',
      !session.active && (await ui('!document.getElementById("session-error").hidden')));

    await ui('document.getElementById("custom-duration").value = "1h30m"; document.getElementById("start-custom").click()');
    await sleep(200);
    check('custom "1h30m" starts a 90-minute session', session.active && Math.abs(session.remainingMs() - 90 * 60_000) < 2000);
    session.stop();

    // 5. Trigger added through the UI, matched against a real process list.
    await ui('document.getElementById("tab-triggers").click()');
    await ui('document.getElementById("trigger-app").value = "electron"; document.getElementById("add-trigger").click()');
    await sleep(300);
    check('trigger added through the UI is saved', settings.get().triggers.length === 1);
    check('adding a trigger shows no error and clears the input',
      await ui('document.getElementById("trigger-error").hidden && document.getElementById("trigger-app").value === ""'));
    check('trigger appears in the list', (await ui('document.querySelectorAll("#trigger-list li").length')) === 1);
    await shot(win, 'triggers');

    await poll();
    check('trigger starts a session when its app is running (real ps)', session.active && session.state.origin === 'trigger');

    const rule = settings.get().triggers[0];
    settings.update({ triggers: [{ ...rule, name: 'definitely-not-running-xyz' }] });
    await poll();
    check('trigger ends the session when the app is gone', !session.active);

    settings.update({ triggers: [] });
    await ui('document.getElementById("tab-general").click()');
    await sleep(100);
    await shot(win, 'general');
    check('trigger list can be emptied', settings.get().triggers.length === 0);
  } catch (err) {
    check('smoke run completed without throwing', false, err && err.stack ? err.stack : String(err));
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? `\nSMOKE OK (${results.length} checks)` : `\nSMOKE FAILED (${failed}/${results.length} checks failed)`);
  return failed === 0 ? 0 : 1;
}

async function shot(win, name) {
  const arg = process.argv.find((a) => a.startsWith('--screenshots='));
  if (!arg) return;
  const dir = arg.slice('--screenshots='.length);
  fs.mkdirSync(dir, { recursive: true });
  await sleep(150);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir, `${name}.png`), image.toPNG());
}

module.exports = { runSmoke };
