'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app, Tray, Menu, BrowserWindow, Notification, nativeImage, powerSaveBlocker, powerMonitor, ipcMain, globalShortcut,
} = require('electron');

const { SessionManager } = require('../core/session');
const { SettingsStore } = require('../core/settings');
const { TriggerEngine, TriggerController } = require('../core/triggers');
const { BatteryGuard } = require('../core/battery-guard');
const { listProcesses, suggestAppNames, getBatteryInfo } = require('../core/system');
const { parseDuration, msUntilTimeOfDay, formatDuration, MAX_DURATION_MS } = require('../core/duration');
const { buildMenuTemplate, trayTitle, statusLabel } = require('./tray-menu');

const SMOKE = process.argv.includes('--smoke');
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const RENDERER_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const POLL_MS = 5000;
const TABS = ['session', 'triggers', 'general'];

let tray = null;
let prefsWindow = null;
let session;
let settings;
let triggerController;
let batteryGuard;
let shortcutError = null;
let registeredShortcut = '';
let lastMenuBuild = 0;

/* ------------------------------- state -------------------------------- */

function snapshot() {
  return {
    session: { ...session.state, remainingMs: session.remainingMs() },
    settings: settings.get(),
    platform: process.platform,
    shortcutError,
  };
}

/** Called on real state changes, so the tray menu is always rebuilt. */
function broadcast() {
  refreshTray(true);
  if (prefsWindow && !prefsWindow.isDestroyed()) prefsWindow.webContents.send('wakeful:state', snapshot());
}

/* ------------------------------ actions ------------------------------- */

function startSession(durationMs, origin = 'manual') {
  session.start({ durationMs, allowDisplaySleep: settings.get().allowDisplaySleep, origin });
}

function startDefaultSession() {
  startSession(settings.get().defaultDurationMs);
}

function toggleSession() {
  if (session.active) session.stop('manual');
  else startDefaultSession();
}

function setAllowDisplaySleep(allow) {
  settings.update({ allowDisplaySleep: allow });
  session.setAllowDisplaySleep(allow);
}

function quit() {
  app.quit();
}

/* ------------------------------- tray --------------------------------- */

const iconCache = new Map();

function trayIcon(active) {
  if (!iconCache.has(active)) {
    const file = path.join(ASSETS, active ? 'trayActiveTemplate.png' : 'trayInactiveTemplate.png');
    const image = nativeImage.createFromPath(file); // picks up the @2x sibling automatically
    if (process.platform === 'darwin') image.setTemplateImage(true);
    iconCache.set(active, image);
  }
  return iconCache.get(active);
}

function refreshTray(forceMenu = false) {
  if (!tray || tray.isDestroyed()) return;
  const snap = snapshot();
  tray.setImage(trayIcon(snap.session.active));
  const title = trayTitle(snap.session, snap.settings);
  if (process.platform === 'darwin') tray.setTitle(title);
  tray.setToolTip(`Wakeful — ${statusLabel(snap.session)}`);

  // Rebuilding the menu is comparatively expensive and can disturb an open menu,
  // so between state changes only refresh it occasionally (for the countdown line).
  const now = Date.now();
  if (forceMenu || now - lastMenuBuild >= 10_000) {
    lastMenuBuild = now;
    tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate({
      session: snap.session,
      settings: snap.settings,
      handlers: { startDefault: startDefaultSession, start: (ms) => startSession(ms), stop: () => session.stop('manual'), setAllowDisplaySleep, openPreferences, quit },
    })));
  }
}

function createTray() {
  tray = new Tray(trayIcon(false));
  refreshTray(true);
}

/* ---------------------------- preferences ----------------------------- */

function openPreferences(tab = 'general') {
  const safeTab = TABS.includes(tab) ? tab : 'general';
  if (prefsWindow && !prefsWindow.isDestroyed()) {
    prefsWindow.show();
    prefsWindow.focus();
    prefsWindow.webContents.send('wakeful:show-tab', safeTab);
    return prefsWindow;
  }

  prefsWindow = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 480,
    minHeight: 520,
    title: 'Wakeful',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const win = prefsWindow;
  win.removeMenu();
  win.loadFile(RENDERER_HTML, { query: { tab: safeTab } });
  win.once('ready-to-show', () => {
    win.show();
    app.focus({ steal: true });
  });
  win.on('closed', () => {
    if (prefsWindow === win) prefsWindow = null;
  });
  // The UI is a single local page: never navigate away or spawn windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

/** Only accept IPC from our own preferences page. */
function trusted(event) {
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === 'string' && url.startsWith(pathToFileURL(RENDERER_HTML).href);
}

/** Bad user input: reported back to the page as `{ error }` rather than logged as a crash. */
class UserError extends Error {}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error('Untrusted sender');
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof UserError) return { error: err.message };
      throw err;
    }
  });
}

function registerIpc() {
  handle('wakeful:get-state', () => snapshot());

  handle('wakeful:start', (opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    let durationMs = null;
    if (typeof o.until === 'string' && o.until) {
      durationMs = msUntilTimeOfDay(o.until);
      if (durationMs === null) throw new UserError('Enter a time like 17:30.');
    } else if (o.duration !== undefined && o.duration !== null && o.duration !== '') {
      durationMs = parseDuration(o.duration);
      if (durationMs === null) throw new UserError(`Enter a duration like 45m, 2h or 1:30 (up to ${formatDuration(MAX_DURATION_MS)}).`);
    }
    if (typeof o.allowDisplaySleep === 'boolean') settings.update({ allowDisplaySleep: o.allowDisplaySleep });
    startSession(durationMs);
    return snapshot();
  });

  handle('wakeful:stop', () => {
    session.stop('manual');
    return snapshot();
  });

  handle('wakeful:update-settings', (patch) => {
    if (patch && typeof patch === 'object' && typeof patch.allowDisplaySleep === 'boolean') {
      session.setAllowDisplaySleep(patch.allowDisplaySleep);
    }
    settings.update(patch);
    return snapshot();
  });

  handle('wakeful:suggest-apps', async () => suggestAppNames(await listProcesses()));
}

/* ----------------------- shortcut / login / notify -------------------- */

function applyShortcut() {
  const wanted = settings.get().toggleShortcut;
  if (wanted === registeredShortcut && !shortcutError) return;
  if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
  registeredShortcut = '';
  shortcutError = null;
  if (!wanted) return;
  try {
    if (globalShortcut.register(wanted, toggleSession)) registeredShortcut = wanted;
    else shortcutError = `"${wanted}" is already in use by another app.`;
  } catch {
    shortcutError = `"${wanted}" is not a valid shortcut. Try something like CommandOrControl+Alt+W.`;
  }
}

function applyLoginItem() {
  const wanted = settings.get().launchAtLogin;
  if (app.getLoginItemSettings().openAtLogin !== wanted) app.setLoginItemSettings({ openAtLogin: wanted });
}

function notify(title, body) {
  if (!settings.get().notifyOnEnd || !Notification.isSupported()) return;
  new Notification({ title, body, silent: true }).show();
}

/* ------------------------------ lifecycle ----------------------------- */

function wire() {
  settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  settings.load();
  settings.on('save-error', (err) => console.error('Could not save settings:', err.message));

  session = new SessionManager({
    blocker: {
      start: (type) => powerSaveBlocker.start(type),
      stop: (id) => powerSaveBlocker.stop(id),
    },
  });
  session.on('change', broadcast);
  session.on('ended', (reason) => {
    if (reason === 'expired') notify('Session finished', 'Your computer can sleep again.');
    else if (reason === 'battery') notify('Session ended', `Battery fell to ${settings.get().batteryCutoffPercent}% or below.`);
  });

  const engine = new TriggerEngine({
    processes: listProcesses,
    onAcPower: async () => !(await getBatteryInfo()).onBattery,
    now: () => new Date(),
  });
  triggerController = new TriggerController({
    session,
    engine,
    getRules: () => settings.get().triggers,
    getSessionOptions: () => ({ allowDisplaySleep: settings.get().allowDisplaySleep }),
  });
  batteryGuard = new BatteryGuard({
    session,
    getBattery: () => getBatteryInfo(),
    getCutoff: () => settings.get().batteryCutoffPercent,
  });

  settings.on('change', () => {
    applyShortcut();
    applyLoginItem();
    broadcast();
  });

  registerIpc();
  createTray();
  applyShortcut();
  applyLoginItem();
}

async function poll() {
  try {
    await batteryGuard.tick();
    await triggerController.tick();
  } catch (err) {
    console.error('Poll failed:', err);
  }
}

function startPolling() {
  const loop = async () => {
    await poll();
    setTimeout(loop, POLL_MS);
  };
  loop();
  // Keep the countdown fresh without touching the (expensive) menu every second.
  setInterval(() => {
    if (session.active) refreshTray();
    if (prefsWindow && !prefsWindow.isDestroyed() && session.active) prefsWindow.webContents.send('wakeful:state', snapshot());
  }, 1000);
  powerMonitor.on('resume', poll);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openPreferences('session'));

  // A menu bar app: keep running with no windows, and stay out of the Dock.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    if (session) session.dispose();
    globalShortcut.unregisterAll();
  });

  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    wire();
    if (settings.get().startSessionAtLaunch) startDefaultSession();
    startPolling();

    if (SMOKE) {
      const { runSmoke } = require('./smoke');
      const code = await runSmoke({ app, session, settings, snapshot, openPreferences, getTray: () => tray, powerSaveBlocker, buildMenuTemplate, poll });
      app.exit(code);
    }
  });
}
