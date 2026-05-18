/* global */

const ShellyBle = (() => {
  // Mongoose OS BLE RPC UUIDs
  const SERVICE_UUID = '5f6d4f53-5f52-5043-5f53-56435f49445f';
  const DATA_UUID = '5f6d4f53-5f52-5043-5f64-6174615f5f5f';
  const TX_CTL_UUID = '5f6d4f53-5f52-5043-5f74-785f63746c5f';
  const RX_CTL_UUID = '5f6d4f53-5f52-5043-5f72-785f63746c5f';

  const connections = new Map();
  // Per-device promise chain to serialize RPC calls. Concurrent GATT
  // operations on the same device cause "GATT operation already in
  // progress" errors and trigger spurious reconnects.
  const sendQueues = new Map();
  let rpcId = 0;
  let onConnectionChange = null;

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

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
    // If there's any existing GATT connection, disconnect first to ensure
    // a clean state. macOS Core Bluetooth can leave stale connections.
    if (device.gatt.connected) {
      device.gatt.disconnect();
      await delay(500);
    }

    const server = await device.gatt.connect();

    // Wait for service discovery and connection parameters to settle.
    // Especially important on macOS where BLE can be flaky.
    await delay(1000);

    const service = await server.getPrimaryService(SERVICE_UUID);
    const dataChar = await service.getCharacteristic(DATA_UUID);
    const txCtlChar = await service.getCharacteristic(TX_CTL_UUID);
    const rxCtlChar = await service.getCharacteristic(RX_CTL_UUID);

    // Start notifications once for the lifetime of the connection.
    // Retry once if it fails; fall back to polling if it still fails.
    let useNotifications = false;
    try {
      await rxCtlChar.startNotifications();
      useNotifications = true;
    } catch (_) {
      await delay(1000);
      try {
        await rxCtlChar.startNotifications();
        useNotifications = true;
      } catch (_) {
        console.warn('[shelly-ble] startNotifications failed, falling back to polling');
      }
    }

    const entry = { device, server, dataChar, txCtlChar, rxCtlChar, useNotifications };
    connections.set(device.name, entry);

    device.addEventListener('gattserverdisconnected', () => {
      connections.delete(device.name);
      if (onConnectionChange) onConnectionChange(device.name, false);
    });

    if (onConnectionChange) onConnectionChange(device.name, true);
  }

  function isConnected(deviceName) {
    const conn = connections.get(deviceName);
    return conn && conn.device.gatt.connected;
  }

  function sendRpc(deviceName, method, params) {
    // Chain onto any in-flight call for this device so RPCs execute
    // sequentially. Concurrent GATT operations cause failures and
    // spurious reconnects.
    const previous = sendQueues.get(deviceName) || Promise.resolve();
    const task = previous
      .catch(() => {}) // a previous failure shouldn't block this call
      .then(() => sendRpcImpl(deviceName, method, params));
    sendQueues.set(deviceName, task);
    // Clear the queue entry once the chain is settled (so it doesn't grow)
    task.finally(() => {
      if (sendQueues.get(deviceName) === task) {
        sendQueues.delete(deviceName);
      }
    });
    return task;
  }

  async function sendRpcImpl(deviceName, method, params) {
    let conn = connections.get(deviceName);
    if (!conn) {
      throw new Error(`Not connected to ${deviceName}`);
    }
    if (!conn.device.gatt.connected) {
      throw new Error(`Device ${deviceName} is disconnected`);
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
    const { dataChar, txCtlChar, rxCtlChar, useNotifications } = conn;

    const request = JSON.stringify({
      id: ++rpcId,
      src: 'midi-hooks',
      method,
      params: params || {},
    });
    const payload = new TextEncoder().encode(request);

    let timeoutId = null;
    let notifyHandler = null;
    const cleanup = () => {
      if (timeoutId !== null) { clearTimeout(timeoutId); timeoutId = null; }
      if (notifyHandler) {
        rxCtlChar.removeEventListener('characteristicvaluechanged', notifyHandler);
        notifyHandler = null;
      }
    };

    try {
      let responseLenPromise;
      if (useNotifications) {
        responseLenPromise = new Promise((resolve, reject) => {
          timeoutId = setTimeout(() => {
            timeoutId = null;
            reject(new Error('Response timeout'));
          }, 3000);
          notifyHandler = (event) => {
            const bytes = new Uint8Array(event.target.value.buffer);
            resolve(bytes.length >= 4 ? event.target.value.getUint32(0, false) : 0);
          };
          rxCtlChar.addEventListener('characteristicvaluechanged', notifyHandler);
        });
      }

      // Write length (4 bytes big-endian) to TX CTL
      const lenBuf = new ArrayBuffer(4);
      new DataView(lenBuf).setUint32(0, payload.length, false);
      await txCtlChar.writeValueWithResponse(new Uint8Array(lenBuf));

      // Write payload to Data characteristic
      const CHUNK_SIZE = 240;
      for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE) {
        const chunk = payload.slice(offset, offset + CHUNK_SIZE);
        await dataChar.writeValueWithResponse(chunk);
      }

      // Get response length via notification or polling
      let responseLen;
      if (useNotifications) {
        responseLen = await responseLenPromise;
      } else {
        responseLen = 0;
        for (let attempt = 0; attempt < 15; attempt++) {
          await delay(200);
          const rxCtlValue = await rxCtlChar.readValue();
          const bytes = new Uint8Array(rxCtlValue.buffer);
          if (bytes.length === 4) {
            const len = rxCtlValue.getUint32(0, false);
            if (len > 0 && len < 10000) {
              responseLen = len;
              break;
            }
          }
        }
      }
      cleanup();

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
    } catch (err) {
      cleanup();
      throw err;
    }
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
