// MIDI handling is done in the renderer via Web MIDI API.
// This module just holds state relayed from the renderer.

class MidiManager {
  constructor() {
    this.deviceName = null;
    this.onCC = null;
    this.onDisconnect = null;
    this.lastValues = new Map();
  }

  setDevice(deviceName) {
    this.deviceName = deviceName;
  }

  clearDevice() {
    this.deviceName = null;
    this.lastValues.clear();
  }

  handleCC(channel, controller, value) {
    const key = `${channel}:${controller}`;
    this.lastValues.set(key, value);
    if (this.onCC) {
      this.onCC(channel, controller, value);
    }
  }

  handleDisconnect(deviceName) {
    this.deviceName = null;
    this.lastValues.clear();
    if (this.onDisconnect) {
      this.onDisconnect(deviceName);
    }
  }

  isOpen() {
    return this.deviceName !== null;
  }
}

module.exports = { MidiManager };
