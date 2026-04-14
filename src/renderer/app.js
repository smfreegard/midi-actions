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
      midiAccess.onstatechange = () => refreshDevices();
      refreshDevices();
    } catch (err) {
      console.error('Web MIDI API not available:', err);
      statusEl.textContent = 'MIDI unavailable';
      statusEl.className = 'status-disconnected';
    }
  }

  function refreshDevices() {
    deviceSelect.innerHTML = '<option value="">-- Select Device --</option>';
    if (!midiAccess) return;

    for (const [id, input] of midiAccess.inputs) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = input.name || id;
      if (input.name === config.midiDeviceName || id === config.midiDeviceName) {
        opt.selected = true;
      }
      deviceSelect.appendChild(opt);
    }

    if (config.midiDeviceName && !currentInput) {
      for (const [id, input] of midiAccess.inputs) {
        if (input.name === config.midiDeviceName || id === config.midiDeviceName) {
          connectDevice(id);
          break;
        }
      }
    }

    if (currentInput) {
      let found = false;
      for (const [id] of midiAccess.inputs) {
        if (id === currentInput.id) {
          found = true;
          break;
        }
      }
      if (!found) handleDisconnect();
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

  refreshBtn.addEventListener('click', refreshDevices);
  addActionBtn.addEventListener('click', () => openActionConfig(-1));

  window.api.onWebhookStatus((data) => {
    const direction = data.isOn ? 'ON' : 'OFF';
    const msg = data.success
      ? `${data.name} ${direction} (${data.detail})`
      : `${data.name} ${direction} FAILED: ${data.detail}`;
    StatusBar.addEntry(msg, data.success);
  });

  // --- Init ---
  renderActions();
  await initMidi();
})();
