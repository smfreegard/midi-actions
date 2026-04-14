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
  onWebhookStatus: (callback) => {
    ipcRenderer.on('webhook:status', (_event, data) => callback(data));
  },

  quit: () => ipcRenderer.send('app:quit'),
});
