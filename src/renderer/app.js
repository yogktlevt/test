'use strict';

/* Preferences UI. Talks to the main process only through window.wakeful (see preload.js). */

const $ = (id) => document.getElementById(id);
const MINUTE = 60 * 1000;
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // week starts Monday

let state = null;
let stateReceivedAt = 0;

/* ------------------------------ helpers ------------------------------- */

function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatMinutes(minutes) {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return [d && plural(d, 'day'), h && plural(h, 'hour'), m && plural(m, 'minute')].filter(Boolean).join(' ');
}

function describeRule(rule) {
  if (rule.type === 'app') return `While ${rule.name} is running`;
  if (rule.type === 'power') return 'While on AC power';
  const key = rule.days.join(',');
  const days = key === '0,1,2,3,4,5,6' ? 'Every day'
    : key === '1,2,3,4,5' ? 'Weekdays'
    : key === '0,6' ? 'Weekends'
    : rule.days.map((d) => DAY_LABELS[d]).join(' ');
  return `${days}, ${rule.start}–${rule.end}`;
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message || '';
  el.hidden = !message;
}

/** Run an IPC call, surfacing a friendly error in the given element. */
async function act(errorId, fn) {
  showError(errorId, '');
  try {
    const next = await fn();
    if (next && next.error) showError(errorId, next.error);
    else if (next) setState(next);
  } catch (err) {
    // Electron prefixes remote errors with "Error invoking remote method ...: Error: "
    showError(errorId, String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
  }
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/* ------------------------------- render ------------------------------- */

function setState(next) {
  state = next;
  stateReceivedAt = Date.now();
  render();
}

function render() {
  if (!state) return;
  renderSession();
  renderTriggers();
  renderGeneral();
}

function remainingNow() {
  const s = state.session;
  if (!s.active || s.endsAt === null) return null;
  return Math.max(0, s.endsAt - Date.now());
}

function renderSession() {
  const s = state.session;
  $('status-card').dataset.active = String(s.active);
  $('status-title').textContent = s.active ? 'Awake' : 'Sleep allowed';
  $('status-detail').textContent = !s.active
    ? 'Your computer will sleep as usual.'
    : s.origin === 'trigger' ? 'Started by a trigger — ends when its condition stops.'
    : s.endsAt === null ? 'Staying awake until you end the session.'
    : 'Staying awake until the timer runs out.';
  renderCountdown();

  const primary = $('primary');
  primary.dataset.active = String(s.active);
  primary.textContent = s.active ? 'End session' : 'Start session';

  const presets = $('presets');
  presets.replaceChildren(
    el('button', { type: 'button', textContent: 'Until I end it', onclick: () => startSession({}) }),
    ...state.settings.durationPresetsMin.map((m) =>
      el('button', { type: 'button', textContent: formatMinutes(m), onclick: () => startSession({ duration: m }) })),
  );

  $('allow-display-sleep').checked = s.active ? s.allowDisplaySleep : state.settings.allowDisplaySleep;
}

function renderCountdown() {
  const remaining = remainingNow();
  $('countdown').textContent = remaining === null ? '' : formatRemaining(remaining);
}

function renderTriggers() {
  const rules = state.settings.triggers;
  $('trigger-empty').hidden = rules.length > 0;
  $('trigger-list').replaceChildren(...rules.map((rule) => {
    const toggle = el('input', { type: 'checkbox', checked: rule.enabled, title: 'Enabled' });
    toggle.setAttribute('aria-label', `Enable: ${describeRule(rule)}`);
    toggle.onchange = () => updateTriggers(rules.map((r) => (r.id === rule.id ? { ...r, enabled: toggle.checked } : r)));
    const remove = el('button', { type: 'button', textContent: 'Remove', className: 'danger' });
    remove.onclick = () => updateTriggers(rules.filter((r) => r.id !== rule.id));
    const li = el('li', {}, toggle, el('span', { textContent: describeRule(rule) }), remove);
    li.dataset.enabled = String(rule.enabled);
    return li;
  }));
}

function renderGeneral() {
  const s = state.settings;
  $('launch-at-login').checked = s.launchAtLogin;
  $('start-at-launch').checked = s.startSessionAtLaunch;
  $('notify-on-end').checked = s.notifyOnEnd;
  $('show-countdown').checked = s.showCountdownInMenuBar;
  $('countdown-toggle').hidden = state.platform !== 'darwin';

  const select = $('default-duration');
  if (document.activeElement !== select) {
    const options = [{ value: 'null', label: 'Until I end it' }, ...s.durationPresetsMin.map((m) => ({ value: String(m * MINUTE), label: formatMinutes(m) }))];
    if (s.defaultDurationMs !== null && !options.some((o) => o.value === String(s.defaultDurationMs))) {
      options.push({ value: String(s.defaultDurationMs), label: formatMinutes(Math.round(s.defaultDurationMs / MINUTE)) });
    }
    select.replaceChildren(...options.map((o) => el('option', { value: o.value, textContent: o.label })));
    select.value = String(s.defaultDurationMs);
  }

  if (document.activeElement !== $('battery-cutoff')) $('battery-cutoff').value = s.batteryCutoffPercent;
  if (document.activeElement !== $('shortcut')) $('shortcut').value = s.toggleShortcut;
  if (document.activeElement !== $('presets-input')) $('presets-input').value = s.durationPresetsMin.join(', ');
  showError('shortcut-error', state.shortcutError);
}

/* ------------------------------- actions ------------------------------ */

function startSession(opts) {
  return act('session-error', () => window.wakeful.start(opts));
}

function updateSettings(patch, errorId = 'general-error') {
  return act(errorId, () => window.wakeful.updateSettings(patch));
}

function updateTriggers(triggers) {
  return updateSettings({ triggers }, 'trigger-error');
}

function addTrigger() {
  const type = $('trigger-type').value;
  let rule;
  if (type === 'app') {
    const name = $('trigger-app').value.trim();
    if (!name) return showError('trigger-error', 'Enter the name of an app, e.g. Xcode.');
    rule = { type, name, enabled: true };
  } else if (type === 'power') {
    rule = { type, enabled: true };
  } else {
    const days = [...document.querySelectorAll('#trigger-days input:checked')].map((i) => Number(i.value));
    const start = $('trigger-start').value;
    const end = $('trigger-end').value;
    if (days.length === 0) return showError('trigger-error', 'Pick at least one day.');
    if (!start || !end || start === end) return showError('trigger-error', 'Choose different start and end times.');
    rule = { type, days, start, end, enabled: true };
  }
  // Capture the count first: the main process pushes the new state to us
  // before this call's reply arrives, so `state` may already include the rule.
  const before = state.settings.triggers.length;
  return act('trigger-error', async () => {
    const next = await window.wakeful.updateSettings({ triggers: [...state.settings.triggers, rule] });
    if (next.settings.triggers.length <= before) throw new Error('That trigger is not valid.');
    $('trigger-app').value = '';
    return next;
  });
}

/* ------------------------------- wiring ------------------------------- */

function showTab(name) {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`panel-${tab.dataset.tab}`).hidden = !selected;
  }
  if (name === 'triggers') loadAppSuggestions();
}

let suggestionsLoaded = false;
async function loadAppSuggestions() {
  if (suggestionsLoaded) return;
  suggestionsLoaded = true;
  try {
    const names = await window.wakeful.suggestApps();
    $('app-suggestions').replaceChildren(...names.slice(0, 500).map((n) => el('option', { value: n })));
  } catch {
    suggestionsLoaded = false;
  }
}

function init() {
  for (const tab of document.querySelectorAll('[role="tab"]')) tab.onclick = () => showTab(tab.dataset.tab);

  $('primary').onclick = () => (state.session.active
    ? act('session-error', () => window.wakeful.stop())
    : startSession({ duration: state.settings.defaultDurationMs === null ? null : state.settings.defaultDurationMs / MINUTE }));
  $('start-custom').onclick = () => {
    const value = $('custom-duration').value.trim();
    if (!value) return showError('session-error', 'Enter a duration like 45m, 2h or 1:30.');
    return startSession({ duration: value });
  };
  $('custom-duration').onkeydown = (e) => { if (e.key === 'Enter') $('start-custom').click(); };
  $('start-until').onclick = () => {
    const value = $('until-time').value;
    if (!value) return showError('session-error', 'Pick a time first.');
    return startSession({ until: value });
  };
  $('allow-display-sleep').onchange = (e) => updateSettings({ allowDisplaySleep: e.target.checked }, 'session-error');

  // Triggers
  $('trigger-days').replaceChildren(...DAY_ORDER.map((d) => {
    const input = el('input', { type: 'checkbox', value: String(d), checked: d >= 1 && d <= 5 });
    return el('label', {}, input, el('span', { textContent: DAY_LABELS[d] }));
  }));
  $('trigger-type').onchange = (e) => {
    $('trigger-app-fields').hidden = e.target.value !== 'app';
    $('trigger-schedule-fields').hidden = e.target.value !== 'schedule';
  };
  $('add-trigger').onclick = addTrigger;
  $('trigger-app').onkeydown = (e) => { if (e.key === 'Enter') addTrigger(); };
  $('trigger-app').onfocus = loadAppSuggestions;

  // General
  const bind = (id, key) => { $(id).onchange = (e) => updateSettings({ [key]: e.target.checked }); };
  bind('launch-at-login', 'launchAtLogin');
  bind('start-at-launch', 'startSessionAtLaunch');
  bind('notify-on-end', 'notifyOnEnd');
  bind('show-countdown', 'showCountdownInMenuBar');
  $('default-duration').onchange = (e) => updateSettings({ defaultDurationMs: e.target.value === 'null' ? null : Number(e.target.value) });
  $('battery-cutoff').onchange = (e) => updateSettings({ batteryCutoffPercent: Number(e.target.value) || 0 });
  $('shortcut').onchange = (e) => updateSettings({ toggleShortcut: e.target.value });
  $('presets-input').onchange = (e) => {
    const minutes = e.target.value.split(',').map((p) => Number(p.trim())).filter((n) => Number.isFinite(n) && n >= 1);
    if (minutes.length === 0) {
      showError('general-error', 'Enter at least one preset, in minutes — for example: 15, 30, 60.');
      return;
    }
    updateSettings({ durationPresetsMin: minutes });
  };

  window.wakeful.onState(setState);
  window.wakeful.onShowTab(showTab);
  setInterval(() => { if (state) renderCountdown(); }, 500);

  const initialTab = new URLSearchParams(location.search).get('tab');
  showTab(['session', 'triggers', 'general'].includes(initialTab) ? initialTab : 'session');
  window.wakeful.getState().then(setState);
}

init();
