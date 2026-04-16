/* global ActionView, ConfigPanel, StatusBar */

(async function () {
  let config = await window.api.getConfig();
  let midiAccess = null;
  let currentInput = null;

  // Track per-action ON/OFF state locally for UI updates
  const actionTriggerState = new Map();

  const deviceSelect = document.getElementById('midi-device');
  const refreshBtn = document.getElementById('midi-refresh');
  const statusEl = document.getElementById('midi-status');
  const addActionBtn = document.getElementById('add-action-btn');

  ConfigPanel.initEvents();

  // --- Web MIDI API ---

  async function initMidi() {
    try {
      midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      midiAccess.onstatechange = (e) => {
        console.log('[midi] state change:', e.port.name, e.port.state);
        populateDeviceList();
      };
      populateDeviceList();
    } catch (err) {
      console.error('Web MIDI API not available:', err);
      statusEl.textContent = 'MIDI unavailable';
      statusEl.className = 'status-disconnected';
    }
  }

  // Chromium's MIDI backend doesn't detect USB devices connected after
  // requestMIDIAccess(). The only reliable fix is a full app restart
  // which re-initializes the entire Chromium process.
  function refreshMidi() {
    window.api.relaunch();
  }

  function populateDeviceList() {
    deviceSelect.innerHTML = '<option value="">-- Select Device --</option>';
    if (!midiAccess) return;

    for (const [id, input] of midiAccess.inputs) {
      if (input.state !== 'connected') continue;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = input.name || id;
      if (input.name === config.midiDeviceName || id === config.midiDeviceName) {
        opt.selected = true;
      }
      deviceSelect.appendChild(opt);
    }

    // Auto-connect if saved device appeared
    if (config.midiDeviceName && !currentInput) {
      for (const [id, input] of midiAccess.inputs) {
        if (input.state === 'connected' &&
            (input.name === config.midiDeviceName || id === config.midiDeviceName)) {
          connectDevice(id);
          break;
        }
      }
    }

    // Detect disconnection of current device
    if (currentInput) {
      const port = midiAccess.inputs.get(currentInput.id);
      if (!port || port.state !== 'connected') {
        handleDisconnect();
      }
    }
  }

  function connectDevice(portId) {
    disconnectDevice();
    if (!midiAccess || !portId) return;

    const input = midiAccess.inputs.get(portId);
    if (!input) return;

    currentInput = { id: portId, name: input.name, port: input };

    input.onmidimessage = (event) => {
      const [status, controller, value] = event.data;
      if (status >= 0xB0 && status <= 0xBF) {
        const channel = status - 0xB0;
        handleMidiCC(channel, controller, value);
      }
    };

    config.midiDeviceName = input.name;
    window.api.midiDeviceSelected(input.name);

    statusEl.textContent = 'Connected';
    statusEl.className = 'status-connected';
  }

  function disconnectDevice() {
    if (currentInput && currentInput.port) {
      currentInput.port.onmidimessage = null;
    }
    currentInput = null;
  }

  function handleDisconnect() {
    const name = currentInput ? currentInput.name : 'Unknown';
    disconnectDevice();
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'status-disconnected';
    window.api.sendMidiDisconnected({ deviceName: name });
    StatusBar.addEntry(`MIDI device disconnected: ${name}`, false);
  }

  function handleMidiCC(channel, controller, value) {
    // Forward to main process for webhook dispatch
    window.api.sendMidiCC({ channel, controller, value });

    // Update CC value display
    ActionView.updateCC(controller, value);

    // Update local action state for UI (mirrors dispatcher OR-logic)
    for (const action of config.actions) {
      const trigger = action.triggers.find((t) => t.ccNumber === controller);
      if (!trigger) continue;

      const threshold = trigger.threshold != null ? trigger.threshold : 1;
      if (!actionTriggerState.has(action.id)) {
        actionTriggerState.set(action.id, new Set());
      }
      const activeSet = actionTriggerState.get(action.id);

      if (value >= threshold) {
        activeSet.add(controller);
      } else {
        activeSet.delete(controller);
      }

      ActionView.updateActionState(action.id, activeSet.size > 0);
    }

    // Forward to config panel for in-modal learn
    if (ConfigPanel.isOpen()) {
      ConfigPanel.handleMidiLearn(controller);
    }
  }

  // --- UI ---

  function generateId(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'action-' + Date.now();
  }

  function renderActions() {
    ActionView.render(config, openActionConfig);
    if (typeof updateReconnectBtnVisibility === 'function') {
      updateReconnectBtnVisibility();
    }
  }

  function openActionConfig(index) {
    const action =
      index === -1
        ? {
            id: '',
            name: '',
            type: 'webhook',
            triggers: [],
            onUrl: '',
            onMethod: 'GET',
            onHeaders: {},
            onBody: null,
            offUrl: '',
            offMethod: 'GET',
            offHeaders: {},
            offBody: null,
          }
        : config.actions[index];

    ConfigPanel.open(action, index, {
      onSave: async (data, idx) => {
        if (idx === -1) {
          data.id = generateId(data.name);
          config.actions.push(data);
        } else {
          data.id = config.actions[idx].id;
          config.actions[idx] = data;
        }
        await window.api.saveConfig(config);
        renderActions();
      },
      onDelete: async (idx) => {
        const removed = config.actions[idx];
        if (removed) {
          actionTriggerState.delete(removed.id);
        }
        config.actions.splice(idx, 1);
        await window.api.saveConfig(config);
        renderActions();
      },
    });
  }

  deviceSelect.addEventListener('change', () => {
    const portId = deviceSelect.value;
    if (portId) {
      connectDevice(portId);
    } else {
      disconnectDevice();
      window.api.midiDisconnect();
      statusEl.textContent = 'Disconnected';
      statusEl.className = 'status-disconnected';
    }
  });

  refreshBtn.addEventListener('click', refreshMidi);
  addActionBtn.addEventListener('click', () => openActionConfig(-1));

  window.api.onWebhookStatus((data) => {
    const direction = data.isOn ? 'ON' : 'OFF';
    const msg = data.success
      ? `${data.name} ${direction} (${data.detail})`
      : `${data.name} ${direction} FAILED: ${data.detail}`;
    StatusBar.addEntry(msg, data.success);
  });

  // --- Shelly BLE ---

  // Listen for fire requests from main process dispatcher
  window.api.onShellyFire(async (data) => {
    const { actionName, deviceName, componentId, on } = data;
    try {
      await ShellyBle.switchSet(deviceName, componentId, on);
      window.api.sendShellyResult({
        actionName,
        on,
        success: true,
        detail: on ? 'ON' : 'OFF',
      });
    } catch (err) {
      window.api.sendShellyResult({
        actionName,
        on,
        success: false,
        detail: err.message,
      });
    }
  });

  // ShellyBle.onConnectionChange is set in the BLE startup banner section below.

  // --- BLE Reconnect button ---

  const reconnectBleBtn = document.getElementById('reconnect-ble-btn');

  function updateReconnectBtnVisibility() {
    const hasShellyActions = config.actions.some(
      (a) => a.type === 'shelly-ble' && a.shellyDeviceName && a.enabled !== false
    );
    reconnectBleBtn.classList.toggle('hidden', !hasShellyActions);
  }

  reconnectBleBtn.addEventListener('click', async () => {
    const deviceNames = [
      ...new Set(
        config.actions
          .filter((a) => a.type === 'shelly-ble' && a.shellyDeviceName && a.enabled !== false)
          .map((a) => a.shellyDeviceName)
      ),
    ];
    if (deviceNames.length === 0) return;

    reconnectBleBtn.disabled = true;
    reconnectBleBtn.textContent = 'Connecting...';

    const results = await ShellyBle.reconnectAll(deviceNames);
    for (const r of results) {
      StatusBar.addEntry(
        r.success ? `${r.name} connected` : `${r.name} failed: ${r.error || 'cancelled'}`,
        r.success
      );
    }

    reconnectBleBtn.disabled = false;
    reconnectBleBtn.textContent = 'Reconnect BLE';
  });

  // --- BLE startup banner ---

  const bleBanner = document.getElementById('ble-banner');
  const bleBannerBtn = document.getElementById('ble-banner-connect');

  function updateBleBanner() {
    const disconnectedDevices = [
      ...new Set(
        config.actions
          .filter((a) => a.type === 'shelly-ble' && a.shellyDeviceName && a.enabled !== false)
          .filter((a) => !ShellyBle.isConnected(a.shellyDeviceName))
          .map((a) => a.shellyDeviceName)
      ),
    ];
    if (disconnectedDevices.length > 0) {
      bleBanner.classList.remove('hidden');
      bleBanner.querySelector('.ble-banner-text').textContent =
        `${disconnectedDevices.length} BLE device(s) need reconnection`;
    } else {
      bleBanner.classList.add('hidden');
    }
  }

  bleBannerBtn.addEventListener('click', async () => {
    const deviceNames = [
      ...new Set(
        config.actions
          .filter((a) => a.type === 'shelly-ble' && a.shellyDeviceName && a.enabled !== false)
          .filter((a) => !ShellyBle.isConnected(a.shellyDeviceName))
          .map((a) => a.shellyDeviceName)
      ),
    ];
    if (deviceNames.length === 0) return;

    bleBannerBtn.disabled = true;
    bleBannerBtn.textContent = 'Connecting...';

    const results = await ShellyBle.reconnectAll(deviceNames);
    for (const r of results) {
      StatusBar.addEntry(
        r.success ? `${r.name} connected` : `${r.name} failed: ${r.error || 'not found'}`,
        r.success
      );
    }

    bleBannerBtn.disabled = false;
    bleBannerBtn.textContent = 'Connect';
    updateBleBanner();
    renderActions();
  });

  // Update banner when BLE connection changes
  const origOnChange = ShellyBle.onConnectionChange;
  ShellyBle.onConnectionChange = (deviceName, connected) => {
    const msg = connected
      ? `Shelly ${deviceName} connected`
      : `Shelly ${deviceName} disconnected`;
    StatusBar.addEntry(msg, connected);
    renderActions();
    updateBleBanner();
  };

  // --- Init ---
  renderActions();
  updateReconnectBtnVisibility();
  updateBleBanner();
  await initMidi();
})();
