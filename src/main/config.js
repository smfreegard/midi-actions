const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

const DEFAULT_CONFIG = {
  version: 2,
  midiDeviceName: null,
  midiChannel: null,
  actions: [],
  webhookTimeoutMs: 5000,
  minimizeToTray: true,
  startMinimized: false,
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const config = JSON.parse(data);
      return { ...DEFAULT_CONFIG, ...config };
    }
  } catch (err) {
    console.error('Failed to load config, using defaults:', err.message);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(tmp, CONFIG_FILE);
}

function getConfigPath() {
  return CONFIG_FILE;
}

module.exports = { loadConfig, saveConfig, getConfigPath, DEFAULT_CONFIG };
