const { ipcMain } = require('electron');

function registerIpcHandlers(mainWindow, midiManager, dispatcher, config, saveConfigFn) {
  // MIDI device management is now in the renderer via Web MIDI API.
  // The renderer forwards CC events to main for webhook dispatch.

  ipcMain.handle('midi:deviceSelected', (_event, deviceName) => {
    midiManager.setDevice(deviceName);
    config.midiDeviceName = deviceName;
    saveConfigFn(config);
    return true;
  });

  ipcMain.handle('midi:disconnect', () => {
    midiManager.clearDevice();
    dispatcher.resetState();
    config.midiDeviceName = null;
    saveConfigFn(config);
    return true;
  });

  ipcMain.on('midi:cc', (_event, data) => {
    const { channel, controller, value } = data;
    midiManager.handleCC(channel, controller, value);
    dispatcher.handleCC(channel, controller, value, config);
  });

  ipcMain.on('midi:deviceDisconnected', (_event, data) => {
    midiManager.handleDisconnect(data.deviceName);
    dispatcher.resetState();
  });

  ipcMain.handle('config:get', () => {
    return { ...config };
  });

  ipcMain.handle('config:save', (_event, newConfig) => {
    Object.assign(config, newConfig);
    saveConfigFn(config);
    dispatcher.timeoutMs = config.webhookTimeoutMs || 5000;
    return true;
  });

  ipcMain.handle('webhook:test', async (_event, url, method, headers, body) => {
    return dispatcher.testWebhook(url, method, headers, body);
  });

  ipcMain.handle('keypress:test', async (_event, keys) => {
    return dispatcher.testKeypress(keys);
  });

  ipcMain.on('app:quit', () => {
    const { app } = require('electron');
    app.isQuitting = true;
    app.quit();
  });

  dispatcher.onStatus = (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('webhook:status', status);
    }
  };
}

module.exports = { registerIpcHandlers };
