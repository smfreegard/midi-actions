const { app, BrowserWindow, dialog, session, ipcMain } = require('electron');
const path = require('path');
const { loadConfig, saveConfig } = require('./config');
const { MidiManager } = require('./midi');
const { ActionDispatcher } = require('./action-dispatcher');
const { KeySender } = require('./key-sender');
const { createTray } = require('./tray');
const { registerIpcHandlers } = require('./ipc-handlers');

let mainWindow = null;
let tray = null;
let config = null;
let midiManager = null;
let dispatcher = null;
let keySender = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    title: 'MIDI Hooks',
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Web Bluetooth device picker with auto-select support.
  // When bleAutoSelectName is set, the handler auto-selects the first
  // device matching that name without showing a dialog.
  let bluetoothCallback = null;
  let bluetoothDevices = [];
  let bluetoothScanTimer = null;
  let bleAutoSelectName = null;

  ipcMain.on('ble:autoselect', (_event, deviceName) => {
    bleAutoSelectName = deviceName || null;
  });

  // MIDI refresh: full app restart (only way to re-init Chromium's MIDI backend)
  ipcMain.on('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  mainWindow.webContents.on(
    'select-bluetooth-device',
    (event, devices, callback) => {
      event.preventDefault();
      bluetoothCallback = callback;

      // Auto-select mode: immediately pick matching device
      if (bleAutoSelectName) {
        const match = devices.find(
          (d) => d.deviceName === bleAutoSelectName
        );
        if (match) {
          bleAutoSelectName = null;
          bluetoothDevices = [];
          if (bluetoothScanTimer) clearTimeout(bluetoothScanTimer);
          callback(match.deviceId);
          return;
        }
        // Device not found yet — keep scanning, timeout after 10s
        if (bluetoothScanTimer) clearTimeout(bluetoothScanTimer);
        bluetoothScanTimer = setTimeout(() => {
          bleAutoSelectName = null;
          bluetoothDevices = [];
          callback('');
        }, 10000);
        return;
      }

      // Manual scan mode: accumulate devices, then show picker
      if (bluetoothDevices.length === 0) {
        mainWindow.webContents.send('ble:scanning', true);
      }

      for (const d of devices) {
        if (!bluetoothDevices.find((x) => x.deviceId === d.deviceId)) {
          bluetoothDevices.push(d);
        }
      }

      if (bluetoothScanTimer) clearTimeout(bluetoothScanTimer);
      bluetoothScanTimer = setTimeout(() => {
        mainWindow.webContents.send('ble:scanning', false);

        if (bluetoothDevices.length === 0) {
          bluetoothCallback('');
          bluetoothDevices = [];
          return;
        }
        if (bluetoothDevices.length === 1) {
          bluetoothCallback(bluetoothDevices[0].deviceId);
          bluetoothDevices = [];
          return;
        }
        dialog
          .showMessageBox(mainWindow, {
            type: 'question',
            title: 'Select Bluetooth Device',
            message: 'Choose a Shelly device:',
            buttons: [
              ...bluetoothDevices.map((d) => d.deviceName || d.deviceId),
              'Cancel',
            ],
            cancelId: bluetoothDevices.length,
          })
          .then(({ response }) => {
            if (response < bluetoothDevices.length) {
              bluetoothCallback(bluetoothDevices[response].deviceId);
            } else {
              bluetoothCallback('');
            }
            bluetoothDevices = [];
          });
      }, 3000);
    }
  );

  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;

    e.preventDefault();
    dialog
      .showMessageBox(mainWindow, {
        type: 'question',
        title: 'MIDI Hooks',
        message: 'What would you like to do?',
        buttons: ['Hide to Tray', 'Quit', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
      })
      .then(({ response }) => {
        if (response === 0) {
          mainWindow.hide();
        } else if (response === 1) {
          app.isQuitting = true;
          app.quit();
        }
      });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function hasKeypressActions(cfg) {
  return (cfg.actions || []).some((a) => a.type === 'keypress');
}

app.whenReady().then(() => {
  config = loadConfig();
  midiManager = new MidiManager();
  keySender = new KeySender();
  dispatcher = new ActionDispatcher(config.webhookTimeoutMs || 5000, keySender);

  // Eagerly start the persistent keystroke process if any keypress actions exist.
  if (hasKeypressActions(config)) {
    keySender.start();
  }

  // Grant Bluetooth permissions so Web Bluetooth API works in the renderer,
  // including navigator.bluetooth.getDevices() for auto-reconnect.
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === 'bluetooth') return true;
    return true;
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(true);
  });

  createWindow();
  tray = createTray(mainWindow);

  registerIpcHandlers(mainWindow, midiManager, dispatcher, config, (cfg) => {
    saveConfig(cfg);
    // If the user just added their first keypress action, start the sender now.
    if (hasKeypressActions(cfg)) {
      keySender.start();
    }
  });

  if (config.startMinimized) {
    mainWindow.hide();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (midiManager) {
    midiManager.clearDevice();
  }
  if (keySender) {
    keySender.shutdown();
  }
});
