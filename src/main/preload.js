'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The only surface the page gets. Every call is validated again in the main process.
contextBridge.exposeInMainWorld('wakeful', {
  getState: () => ipcRenderer.invoke('wakeful:get-state'),
  start: (opts) => ipcRenderer.invoke('wakeful:start', opts),
  stop: () => ipcRenderer.invoke('wakeful:stop'),
  updateSettings: (patch) => ipcRenderer.invoke('wakeful:update-settings', patch),
  suggestApps: () => ipcRenderer.invoke('wakeful:suggest-apps'),
  onState: (callback) => {
    ipcRenderer.on('wakeful:state', (_event, state) => callback(state));
  },
  onShowTab: (callback) => {
    ipcRenderer.on('wakeful:show-tab', (_event, tab) => callback(tab));
  },
});
