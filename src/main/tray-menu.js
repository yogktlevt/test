'use strict';

const { formatRemaining, formatDuration, MINUTE } = require('../core/duration');

/** One-line status for the top of the tray menu. */
function statusLabel(session) {
  if (!session.active) return 'Sleep allowed';
  const via = session.origin === 'trigger' ? 'trigger' : null;
  let text;
  if (session.remainingMs === null) {
    text = via ? 'Awake while a trigger matches' : 'Awake until you end the session';
  } else {
    text = `Awake — ${formatRemaining(session.remainingMs)} left`;
  }
  return session.allowDisplaySleep ? `${text} (display may sleep)` : text;
}

/** Text shown next to the tray icon on macOS; '' when there is nothing to show. */
function trayTitle(session, settings) {
  if (!session.active || !settings.showCountdownInMenuBar || session.remainingMs === null) return '';
  return ` ${formatRemaining(session.remainingMs)}`;
}

/**
 * Build the Electron menu template. Pure: everything it needs is passed in,
 * so it can be tested without Electron.
 *
 * @param {object} p
 * @param {object} p.session   UI snapshot ({ active, origin, remainingMs, allowDisplaySleep })
 * @param {object} p.settings
 * @param {object} p.handlers  { startDefault, start(durationMs|null), stop, setAllowDisplaySleep(bool), openPreferences(tab), quit }
 * @param {string} [p.appName]
 */
function buildMenuTemplate({ session, settings, handlers, appName = 'Wakeful' }) {
  const defaultLabel = settings.defaultDurationMs === null
    ? 'Start Session'
    : `Start Session (${formatDuration(settings.defaultDurationMs)})`;

  const presets = settings.durationPresetsMin.map((minutes) => ({
    label: formatDuration(minutes * MINUTE),
    click: () => handlers.start(minutes * MINUTE),
  }));

  return [
    { label: statusLabel(session), enabled: false },
    { type: 'separator' },
    session.active
      ? { label: 'End Session', click: () => handlers.stop() }
      : { label: defaultLabel, click: () => handlers.startDefault() },
    {
      label: 'Start Session For',
      submenu: [
        { label: 'Until I End It', click: () => handlers.start(null) },
        { type: 'separator' },
        ...presets,
        { type: 'separator' },
        { label: 'Custom…', click: () => handlers.openPreferences('session') },
      ],
    },
    {
      label: 'Allow Display Sleep',
      type: 'checkbox',
      checked: Boolean(session.active ? session.allowDisplaySleep : settings.allowDisplaySleep),
      click: (item) => handlers.setAllowDisplaySleep(item.checked),
    },
    { type: 'separator' },
    { label: 'Triggers…', click: () => handlers.openPreferences('triggers') },
    { label: 'Preferences…', accelerator: 'CommandOrControl+,', click: () => handlers.openPreferences('general') },
    { type: 'separator' },
    { label: `Quit ${appName}`, accelerator: 'CommandOrControl+Q', click: () => handlers.quit() },
  ];
}

module.exports = { buildMenuTemplate, statusLabel, trayTitle };
