/* global */

const ShellyBle = (() => {
  // Mongoose OS BLE RPC UUIDs
  const SERVICE_UUID = '5f6d4f53-5f52-5043-5f53-56435f49445f';
  const DATA_UUID = '5f6d4f53-5f52-5043-5f64-6174615f5f5f';
  const TX_CTL_UUID = '5f6d4f53-5f52-5043-5f74-785f63746c5f';
  const RX_CTL_UUID = '5f6d4f53-5f52-5043-5f72-785f63746c5f';

  // Connected devices: Map<deviceName, {device, server, dataChar, txCtlChar, rxCtlChar}>
  const connections = new Map();

  // Monotonically increasing RPC ID
  let rpcId = 0;

  // Status callback for connection state changes
  let onConnectionChange = null;

  /**
   * Request a Shelly device via Web Bluetooth picker (requires user gesture).
   * Returns the device name on success, null on cancel.
   */
  async function scan() {
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'Shelly' }],
        optionalServices: [SERVICE_UUID],
      });
      if (!device) return null;

      await connectDevice(device);
      return device.name;
    } catch (err) {
      if (err.name === 'NotFoundError') {
        // User cancelled the picker
        return null;
      }
      throw err;
    }
  }

  /**
   * Connect to a BluetoothDevice and cache the GATT characteristics.
   */
  async function connectDevice(device) {
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const dataChar = await service.getCharacteristic(DATA_UUID);
    const txCtlChar = await service.getCharacteristic(TX_CTL_UUID);
    const rxCtlChar = await service.getCharacteristic(RX_CTL_UUID);

    const entry = { device, server, dataChar, txCtlChar, rxCtlChar };
    connections.set(device.name, entry);

    device.addEventListener('gattserverdisconnected', () => {
      console.warn(`[shelly-ble] Device disconnected: ${device.name}`);
      if (onConnectionChange) onConnectionChange(device.name, false);
      // Attempt auto-reconnect after a short delay
      setTimeout(() => autoReconnect(device), 2000);
    });

    if (onConnectionChange) onConnectionChange(device.name, true);
    console.log(`[shelly-ble] Connected to ${device.name}`);
  }

  /**
   * Attempt to reconnect a previously-paired device.
   */
  async function autoReconnect(device) {
    if (!device.gatt) return;
    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      const dataChar = await service.getCharacteristic(DATA_UUID);
      const txCtlChar = await service.getCharacteristic(TX_CTL_UUID);
      const rxCtlChar = await service.getCharacteristic(RX_CTL_UUID);

      connections.set(device.name, { device, server, dataChar, txCtlChar, rxCtlChar });
      if (onConnectionChange) onConnectionChange(device.name, true);
      console.log(`[shelly-ble] Reconnected to ${device.name}`);
    } catch (err) {
      console.warn(`[shelly-ble] Reconnect failed for ${device.name}:`, err.message);
    }
  }

  /**
   * Check if a device is currently connected.
   */
  function isConnected(deviceName) {
    const conn = connections.get(deviceName);
    return conn && conn.device.gatt.connected;
  }

  /**
   * Send a JSON-RPC command to a connected Shelly device via BLE.
   * Returns the parsed JSON response.
   */
  async function sendRpc(deviceName, method, params) {
    const conn = connections.get(deviceName);
    if (!conn) {
      throw new Error(`Not connected to ${deviceName}`);
    }
    if (!conn.device.gatt.connected) {
      // Try one reconnect
      await autoReconnect(conn.device);
      if (!conn.device.gatt.connected) {
        throw new Error(`Device ${deviceName} is disconnected`);
      }
    }

    const { dataChar, txCtlChar, rxCtlChar } = connections.get(deviceName);

    const request = JSON.stringify({
      id: ++rpcId,
      src: 'midi-hooks',
      method,
      params: params || {},
    });

    const payload = new TextEncoder().encode(request);

    // 1. Write payload length (4 bytes, big-endian) to TX Control
    const lenBuf = new ArrayBuffer(4);
    new DataView(lenBuf).setUint32(0, payload.length, false); // big-endian
    await txCtlChar.writeValueWithResponse(new Uint8Array(lenBuf));

    // 2. Write payload to Data characteristic (chunk if needed)
    const CHUNK_SIZE = 240; // Stay under typical MTU
    for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE) {
      const chunk = payload.slice(offset, offset + CHUNK_SIZE);
      await dataChar.writeValueWithResponse(chunk);
    }

    // 3. Read response length from RX Control
    const rxCtlValue = await rxCtlChar.readValue();
    const responseLen = rxCtlValue.getUint32(0, false); // big-endian

    if (responseLen === 0) {
      return null;
    }

    // 4. Read response from Data characteristic in chunks
    let responseBytes = new Uint8Array(0);
    while (responseBytes.length < responseLen) {
      const chunk = await dataChar.readValue();
      const chunkArr = new Uint8Array(chunk.buffer);
      const combined = new Uint8Array(responseBytes.length + chunkArr.length);
      combined.set(responseBytes);
      combined.set(chunkArr, responseBytes.length);
      responseBytes = combined;
    }

    const responseText = new TextDecoder().decode(responseBytes.slice(0, responseLen));
    return JSON.parse(responseText);
  }

  /**
   * Set the switch state on a Shelly device.
   */
  async function switchSet(deviceName, componentId, on) {
    return sendRpc(deviceName, 'Switch.Set', { id: componentId, on });
  }

  /**
   * Toggle the switch on a Shelly device.
   */
  async function switchToggle(deviceName, componentId) {
    return sendRpc(deviceName, 'Switch.Toggle', { id: componentId });
  }

  /**
   * Get all connected device names.
   */
  function getConnectedDevices() {
    const result = [];
    for (const [name, conn] of connections) {
      if (conn.device.gatt.connected) {
        result.push(name);
      }
    }
    return result;
  }

  /**
   * Reconnect to a specific device by name using auto-select.
   * Tells main process to auto-pick the device by name (no picker shown),
   * then calls requestDevice() which triggers the BLE scan.
   */
  async function reconnectByName(deviceName) {
    if (connections.has(deviceName)) {
      const conn = connections.get(deviceName);
      if (conn.device.gatt.connected) return deviceName;
    }
    try {
      // Tell main to auto-select this device name when it appears in scan
      window.api.bleAutoSelect(deviceName);
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ name: deviceName }],
        optionalServices: [SERVICE_UUID],
      });
      if (!device) return null;
      await connectDevice(device);
      return device.name;
    } catch (err) {
      if (err.name === 'NotFoundError') return null;
      throw err;
    }
  }

  /**
   * Reconnect all devices from a list of names, sequentially.
   * Each connection is auto-selected by main (no picker dialog).
   */
  async function reconnectAll(deviceNames) {
    const results = [];
    for (const name of deviceNames) {
      if (connections.has(name) && connections.get(name).device.gatt.connected) {
        results.push({ name, success: true });
        continue;
      }
      try {
        const result = await reconnectByName(name);
        results.push({ name, success: !!result });
      } catch (err) {
        results.push({ name, success: false, error: err.message });
      }
    }
    return results;
  }

  return {
    scan,
    isConnected,
    switchSet,
    switchToggle,
    sendRpc,
    getConnectedDevices,
    reconnectByName,
    reconnectAll,
    set onConnectionChange(fn) { onConnectionChange = fn; },
  };
})();
