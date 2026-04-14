const { app, BrowserWindow, dialog } = require('electron');
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
