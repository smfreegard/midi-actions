const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // MIDI device selected/disconnected (renderer tells main)
  midiDeviceSelected: (name) => ipcRenderer.invoke('midi:deviceSelected', name),
  midiDisconnect: () => ipcRenderer.invoke('midi:disconnect'),
  sendMidiCC: (data) => ipcRenderer.send('midi:cc', data),
  sendMidiDisconnected: (data) => ipcRenderer.send('midi:deviceDisconnected', data),

  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),

  // Webhook test
  testWebhook: (url, method, headers, body) =>
    ipcRenderer.invoke('webhook:test', url, method, headers, body),

  // Keypress test
  testKeypress: (keys) => ipcRenderer.invoke('keypress:test', keys),

  // Shelly BLE: main asks renderer to fire
  onShellyFire: (callback) => {
    ipcRenderer.on('shelly:fire', (_event, data) => callback(data));
  },
  sendShellyResult: (data) => ipcRenderer.send('shelly:result', data),

  // BLE scanning status and auto-select
  onBleScanning: (callback) => {
    ipcRenderer.on('ble:scanning', (_event, scanning) => callback(scanning));
  },
  bleAutoSelect: (deviceName) => ipcRenderer.send('ble:autoselect', deviceName),

  // App relaunch (for MIDI refresh)
  relaunch: () => ipcRenderer.send('app:relaunch'),

  onWebhookStatus: (callback) => {
    ipcRenderer.on('webhook:status', (_event, data) => callback(data));
  },

  quit: () => ipcRenderer.send('app:quit'),
});
