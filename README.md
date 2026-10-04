# Wakeful

A menu bar app that keeps your computer awake — in the spirit of
[Amphetamine](https://apps.apple.com/us/app/amphetamine/id937984704) for macOS,
built with Electron so it also runs on Windows and Linux.

Wakeful is an independent project and is not affiliated with Amphetamine.

## Features

- **Menu bar / tray app.** An open-eye icon means awake, a closed eye means sleep is allowed. On macOS the remaining time is shown next to the icon.
- **Sessions.** Start one indefinitely, for a preset (15 min – 8 h), for a custom length (`45m`, `2h30m`, `1:30`), or until a time of day.
- **Display control.** Keep the display on, or *Allow Display Sleep* to keep only the system awake.
- **Triggers.** Start a session automatically while:
  - a chosen app is running,
  - the computer is on AC power, or
  - a schedule is active (days + time window, overnight windows supported).

  Triggers only ever end sessions they started. If you end a trigger session by hand, it stays off until the condition has cleared once.
- **Battery cutoff.** End the session when on battery at or below a chosen percentage.
- **Extras.** Global shortcut to toggle a session, launch at login, start a session at launch, and a notification when a session ends.

## Status

Developed and tested on Linux (unit tests plus the Electron smoke test under Xvfb).
The macOS and Windows code paths — `pmset` / PowerShell battery parsing, the tray
countdown title, launch at login, packaging — are covered by unit tests of the parsers
where possible but have **not** been run on those systems yet.

## Run it

```sh
npm install
npm start
```

Preferences open from the tray menu (**Preferences…**, **Triggers…**, or **Start Session For → Custom…**).

On Linux the tray icon needs a desktop that supports status icons (for example
GNOME with the AppIndicator extension).

## How it works

Electron's `powerSaveBlocker` holds an OS power assertion for as long as a session is active:
`prevent-display-sleep` normally, or `prevent-app-suspension` when display sleep is allowed.
On macOS these are IOKit assertions — the same mechanism `caffeinate` uses.

```
src/core/       Electron-free logic, unit tested
  session.js      the keep-awake session (timer + OS blocker, injected)
  triggers.js     trigger rules, evaluation, and the controller that acts on them
  battery-guard.js  ends sessions at low battery
  system.js       process list + battery readers (macOS / Linux / Windows)
  settings.js     validated, atomically-written JSON settings
  duration.js     duration parsing and formatting
src/main/       Electron main process: tray, menu, windows, IPC
src/renderer/   Preferences UI (sandboxed, context-isolated, strict CSP)
scripts/        icon generator, smoke-test runner
```

## Test

```sh
npm test         # unit tests for src/core and the tray menu (node:test, no Electron needed)
npm run smoke    # launches the real app in a throwaway profile and drives it end to end
```

`npm run smoke` uses `xvfb-run` on Linux when there is no display. It checks that the OS
blocker is actually acquired and released, timers expire, the tray and menu build, the
preferences UI works over IPC, and a trigger matches a real running process.
Add `-- --screenshots=./shots` to save PNGs of the UI.

## Build installers

```sh
npm run dist
```

This uses `electron-builder` (config in `package.json`). On macOS the app runs as a
menu bar agent (`LSUIElement`), with no Dock icon. Packaging is configured but has not been
run in CI here, and the app is unsigned, so macOS Gatekeeper will ask you to approve it.

## Regenerate icons

```sh
npm run icons
```
