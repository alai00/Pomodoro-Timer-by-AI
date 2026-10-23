'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pomodoro', {
  getData: () => ipcRenderer.invoke('get-data'),
  setSettings: (patch) => ipcRenderer.send('set-settings', patch),
  addCount: (key) => ipcRenderer.invoke('add-count', key),
  armPhaseTimeout: (endAt) => ipcRenderer.send('arm-phase-timeout', endAt),
  onPhaseTimeout: (cb) => ipcRenderer.on('phase-timeout', () => cb()),
  onModeChanged: (cb) => ipcRenderer.on('mode-changed', (e, m) => cb(m)),
  setInteractive: (on) => ipcRenderer.send('set-interactive', !!on),
  setPowerSave: (on) => ipcRenderer.send('psb', !!on),
  showBall: () => ipcRenderer.send('show-ball'),
  dragStart: (dx, dy) => ipcRenderer.send('drag-start', dx, dy),
  dragEnd: () => ipcRenderer.send('drag-end'),
  panelHold: (on) => ipcRenderer.send('panel-hold', !!on)
});
