/* global */

const ShellyBle = (() => {
  // Mongoose OS BLE RPC UUIDs
  const SERVICE_UUID = '5f6d4f53-5f52-5043-5f53-56435f49445f';
  const DATA_UUID = '5f6d4f53-5f52-5043-5f64-6174615f5f5f';
  const TX_CTL_UUID = '5f6d4f53-5f52-5043-5f74-785f63746c5f';
  const RX_CTL_UUID = '5f6d4f53-5f52-5043-5f72-785f63746c5f';

  const connections = new Map();
  let rpcId = 0;
  let onConnectionChange = null;

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
      if (err.name === 'NotFoundError') return null;
      throw err;
    }
  }

  async function connectDevice(device) {
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const dataChar = await service.getCharacteristic(DATA_UUID);
    const txCtlChar = await service.getCharacteristic(TX_CTL_UUID);
    const rxCtlChar = await service.getCharacteristic(RX_CTL_UUID);

    const entry = { device, server, dataChar, txCtlChar, rxCtlChar };
    connections.set(device.name, entry);

    device.addEventListener('gattserverdisconnected', () => {
      if (onConnectionChange) onConnectionChange(device.name, false);
      setTimeout(() => autoReconnect(device), 2000);
    });

    if (onConnectionChange) onConnectionChange(device.name, true);
  }

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
    } catch (err) {
      console.warn('[shelly-ble] Reconnect failed:', err.message);
    }
  }

  function isConnected(deviceName) {
    const conn = connections.get(deviceName);
    return conn && conn.device.gatt.connected;
  }

  async function sendRpc(deviceName, method, params) {
    let conn = connections.get(deviceName);
    if (!conn) {
      throw new Error(`Not connected to ${deviceName}`);
    }
    if (!conn.device.gatt.connected) {
      await autoReconnect(conn.device);
      conn = connections.get(deviceName);
      if (!conn || !conn.device.gatt.connected) {
        throw new Error(`Device ${deviceName} is disconnected`);
      }
    }

    try {
      return await sendRpcInner(conn, method, params);
    } catch (err) {
      // GATT failure — kill stale connection so UI shows disconnected
      // and the banner prompts the user to reconnect.
      try { conn.device.gatt.disconnect(); } catch (_) {}
      connections.delete(deviceName);
      if (onConnectionChange) onConnectionChange(deviceName, false);
      throw new Error(`${deviceName} disconnected — click Connect to reconnect`);
    }
  }

  async function sendRpcInner(conn, method, params) {
    const { dataChar, txCtlChar, rxCtlChar } = conn;

    const request = JSON.stringify({
      id: ++rpcId,
      src: 'midi-hooks',
      method,
      params: params || {},
    });
    const payload = new TextEncoder().encode(request);

    // Subscribe to RX CTL notifications before sending
    const responseLenPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        rxCtlChar.removeEventListener('characteristicvaluechanged', handler);
        rxCtlChar.stopNotifications().catch(() => {});
        reject(new Error('Response timeout (10s)'));
      }, 10000);

      function handler(event) {
        clearTimeout(timeout);
        rxCtlChar.removeEventListener('characteristicvaluechanged', handler);
        const value = event.target.value;
        const bytes = new Uint8Array(value.buffer);
        resolve(bytes.length >= 4 ? value.getUint32(0, false) : 0);
      }

      rxCtlChar.addEventListener('characteristicvaluechanged', handler);
    });
    await rxCtlChar.startNotifications();

    // Write payload length (4 bytes big-endian) to TX Control
    const lenBuf = new ArrayBuffer(4);
    new DataView(lenBuf).setUint32(0, payload.length, false);
    await txCtlChar.writeValueWithResponse(new Uint8Array(lenBuf));

    // Write payload to Data characteristic
    const CHUNK_SIZE = 240;
    for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE) {
      const chunk = payload.slice(offset, offset + CHUNK_SIZE);
      await dataChar.writeValueWithResponse(chunk);
    }

    // Wait for RX CTL notification with response length
    const responseLen = await responseLenPromise;
    await rxCtlChar.stopNotifications();

    if (responseLen === 0) return null;

    // Read response from Data characteristic
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

  async function switchSet(deviceName, componentId, on) {
    return sendRpc(deviceName, 'Switch.Set', { id: componentId, on });
  }

  async function switchToggle(deviceName, componentId) {
    return sendRpc(deviceName, 'Switch.Toggle', { id: componentId });
  }

  function getConnectedDevices() {
    const result = [];
    for (const [name, conn] of connections) {
      if (conn.device.gatt.connected) result.push(name);
    }
    return result;
  }

  async function reconnectByName(deviceName) {
    if (connections.has(deviceName)) {
      const conn = connections.get(deviceName);
      if (conn.device.gatt.connected) return deviceName;
    }
    try {
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
