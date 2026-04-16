/* global StatusBar */

// ======================================================================
// Keyboard event → canonical combo string
// ======================================================================

const MODIFIER_KEYS = new Set([
  'Control', 'Shift', 'Alt', 'Meta',
  'ControlLeft', 'ControlRight',
  'ShiftLeft', 'ShiftRight',
  'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight',
]);

const CODE_TO_NAME = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Escape: 'escape',
  Tab: 'tab',
  Space: 'space',
  Backspace: 'backspace',
  Delete: 'delete',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
};

function keyEventToCombo(event) {
  // Ignore events where only a modifier is pressed
  if (MODIFIER_KEYS.has(event.key) || MODIFIER_KEYS.has(event.code)) {
    return null;
  }

  const modifiers = [];
  if (event.ctrlKey) modifiers.push('ctrl');
  if (event.shiftKey) modifiers.push('shift');
  if (event.altKey) modifiers.push('alt');
  if (event.metaKey) modifiers.push('meta');

  let base = null;
  if (CODE_TO_NAME[event.code]) {
    base = CODE_TO_NAME[event.code];
  } else if (/^Key[A-Z]$/.test(event.code)) {
    base = event.code.slice(3).toLowerCase();
  } else if (/^Digit[0-9]$/.test(event.code)) {
    base = event.code.slice(5);
  } else if (/^Numpad[0-9]$/.test(event.code)) {
    base = event.code.slice(6);
  } else if (/^F([1-9]|1[0-2])$/.test(event.code)) {
    base = event.code.toLowerCase();
  } else {
    return null;
  }

  return [...modifiers, base].join('+');
}

// ======================================================================
// Config Panel
// ======================================================================

const ConfigPanel = (() => {
  const modal = () => document.getElementById('action-modal');
  const titleEl = () => document.getElementById('modal-title');
  const nameInput = () => document.getElementById('action-name');
  const typeSelect = () => document.getElementById('action-type');
  const enabledCheckbox = () => document.getElementById('action-enabled');
  const triggersList = () => document.getElementById('triggers-list');
  const learnBtn = () => document.getElementById('trigger-learn-btn');
  const learnStatus = () => document.getElementById('trigger-learn-status');
  const webhookFields = () => document.getElementById('webhook-fields');
  const keypressFields = () => document.getElementById('keypress-fields');
  const shellyBleFields = () => document.getElementById('shelly-ble-fields');
  const onMethodSelect = () => document.getElementById('on-method');
  const onUrlInput = () => document.getElementById('on-url');
  const offMethodSelect = () => document.getElementById('off-method');
  const offUrlInput = () => document.getElementById('off-url');
  const keysDisplay = () => document.getElementById('keys-display');
  const keysLearnBtn = () => document.getElementById('keys-learn-btn');
  const debounceInput = () => document.getElementById('debounce-ms');
  const shellyDeviceNameInput = () => document.getElementById('shelly-device-name');
  const shellyComponentIdInput = () => document.getElementById('shelly-component-id');
  const shellyBleStatusEl = () => document.getElementById('shelly-ble-status');

  let currentActionIndex = null;
  let currentTriggers = [];
  let currentKeys = '';
  let currentShellyDeviceName = '';
  let onSaveCallback = null;
  let onDeleteCallback = null;
  let isLearningTriggers = false;
  let isLearningKeys = false;

  function open(action, index, callbacks) {
    currentActionIndex = index;
    onSaveCallback = callbacks.onSave;
    onDeleteCallback = callbacks.onDelete;

    titleEl().textContent = index === -1 ? 'Add Action' : 'Configure Action';
    nameInput().value = action.name || '';
    typeSelect().value = action.type || 'webhook';
    enabledCheckbox().checked = action.enabled !== false;

    onMethodSelect().value = action.onMethod || 'GET';
    onUrlInput().value = action.onUrl || '';
    offMethodSelect().value = action.offMethod || 'GET';
    offUrlInput().value = action.offUrl || '';

    currentKeys = action.keys || '';
    keysDisplay().value = currentKeys;
    debounceInput().value = action.debounceMs != null ? action.debounceMs : 200;

    currentShellyDeviceName = action.shellyDeviceName || '';
    shellyDeviceNameInput().value = currentShellyDeviceName;
    shellyComponentIdInput().value = action.shellyComponentId != null ? action.shellyComponentId : 0;
    updateShellyStatus();

    currentTriggers = (action.triggers || []).map((t) => ({ ...t }));
    renderTriggers();
    updateTypeVisibility();

    document.getElementById('modal-delete').classList.toggle('hidden', index === -1);

    modal().classList.remove('hidden');
    nameInput().focus();
    stopLearningTriggers();
    stopLearningKeys();
  }

  function close() {
    modal().classList.add('hidden');
    stopLearningTriggers();
    stopLearningKeys();
    currentActionIndex = null;
    currentTriggers = [];
    currentKeys = '';
    currentShellyDeviceName = '';
  }

  function isOpen() {
    return !modal().classList.contains('hidden');
  }

  function updateTypeVisibility() {
    const type = typeSelect().value;
    webhookFields().classList.toggle('hidden', type !== 'webhook');
    keypressFields().classList.toggle('hidden', type !== 'keypress');
    shellyBleFields().classList.toggle('hidden', type !== 'shelly-ble');
  }

  function updateShellyStatus() {
    if (typeof ShellyBle !== 'undefined' && currentShellyDeviceName) {
      const connected = ShellyBle.isConnected(currentShellyDeviceName);
      shellyBleStatusEl().textContent = connected ? 'Connected' : 'Disconnected';
      shellyBleStatusEl().className = connected ? 'form-hint status-connected' : 'form-hint status-disconnected';
    } else {
      shellyBleStatusEl().textContent = 'Not connected';
      shellyBleStatusEl().className = 'form-hint';
    }
  }

  // --- MIDI trigger learn ---

  function startLearningTriggers() {
    isLearningTriggers = true;
    learnBtn().textContent = 'Done';
    learnBtn().classList.add('active');
    learnStatus().classList.remove('hidden');
  }

  function stopLearningTriggers() {
    isLearningTriggers = false;
    learnBtn().textContent = 'Learn';
    learnBtn().classList.remove('active');
    learnStatus().classList.add('hidden');
  }

  function handleMidiLearn(ccNumber) {
    if (!isLearningTriggers) return;
    const exists = currentTriggers.some((t) => t.ccNumber === ccNumber);
    if (!exists) {
      currentTriggers.push({ ccNumber, threshold: 1 });
      renderTriggers();
    }
  }

  function renderTriggers() {
    const list = triggersList();
    list.innerHTML = '';

    if (currentTriggers.length === 0) {
      list.innerHTML = '<div class="no-triggers-msg">No triggers assigned. Click Learn and move a control.</div>';
      return;
    }

    currentTriggers.forEach((trigger, i) => {
      const row = document.createElement('div');
      row.className = 'trigger-row';
      row.innerHTML = `
        <span class="trigger-cc-label">CC ${trigger.ccNumber}</span>
        <label class="trigger-threshold-label">Threshold:</label>
        <input type="range" class="trigger-threshold" min="0" max="127" value="${trigger.threshold != null ? trigger.threshold : 1}" data-index="${i}">
        <span class="trigger-threshold-value">${trigger.threshold != null ? trigger.threshold : 1}</span>
        <button class="btn-small btn-danger trigger-remove" data-index="${i}">&times;</button>
      `;

      const rangeInput = row.querySelector('.trigger-threshold');
      const valueSpan = row.querySelector('.trigger-threshold-value');

      rangeInput.addEventListener('input', () => {
        const val = parseInt(rangeInput.value, 10);
        currentTriggers[i].threshold = val;
        valueSpan.textContent = val;
      });

      row.querySelector('.trigger-remove').addEventListener('click', () => {
        currentTriggers.splice(i, 1);
        renderTriggers();
      });

      list.appendChild(row);
    });
  }

  // --- Key combo learn ---

  function startLearningKeys() {
    isLearningKeys = true;
    keysLearnBtn().textContent = 'Press keys...';
    keysLearnBtn().classList.add('active');
    keysDisplay().placeholder = 'Press a key combination (Esc to cancel)';
  }

  function stopLearningKeys() {
    isLearningKeys = false;
    keysLearnBtn().textContent = 'Learn Keys';
    keysLearnBtn().classList.remove('active');
    keysDisplay().placeholder = 'Click Learn Keys and press a combination';
  }

  function handleKeyCapture(event) {
    if (!isLearningKeys) return;
    event.preventDefault();
    event.stopPropagation();

    // Escape cancels
    if (event.code === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      stopLearningKeys();
      return;
    }

    const combo = keyEventToCombo(event);
    if (combo) {
      currentKeys = combo;
      keysDisplay().value = combo;
      stopLearningKeys();
    }
  }

  // --- Collect + save ---

  function collectActionData() {
    const name = nameInput().value.trim();
    if (!name) return null;

    const type = typeSelect().value;

    const base = {
      name,
      type,
      triggers: currentTriggers,
      enabled: enabledCheckbox().checked,
    };

    if (type === 'webhook') {
      return {
        ...base,
        onUrl: onUrlInput().value.trim(),
        onMethod: onMethodSelect().value,
        onHeaders: {},
        onBody: null,
        offUrl: offUrlInput().value.trim(),
        offMethod: offMethodSelect().value,
        offHeaders: {},
        offBody: null,
      };
    }
    if (type === 'keypress') {
      if (!currentKeys) return null; // validation: keys required
      const dbRaw = parseInt(debounceInput().value, 10);
      return {
        ...base,
        keys: currentKeys,
        debounceMs: isNaN(dbRaw) ? 200 : Math.max(0, dbRaw),
      };
    }
    if (type === 'shelly-ble') {
      if (!currentShellyDeviceName) return null; // validation: device required
      return {
        ...base,
        shellyDeviceName: currentShellyDeviceName,
        shellyComponentId: parseInt(shellyComponentIdInput().value, 10) || 0,
      };
    }
    return null;
  }

  function initEvents() {
    typeSelect().addEventListener('change', updateTypeVisibility);

    learnBtn().addEventListener('click', () => {
      if (isLearningTriggers) stopLearningTriggers();
      else startLearningTriggers();
    });

    keysLearnBtn().addEventListener('click', () => {
      if (isLearningKeys) stopLearningKeys();
      else startLearningKeys();
    });

    // Capture keydown on the modal when learning keys. Use the whole document
    // while learning so focus location doesn't matter.
    document.addEventListener('keydown', handleKeyCapture, true);

    document.getElementById('test-on-btn').addEventListener('click', () => {
      const url = onUrlInput().value.trim();
      const method = onMethodSelect().value;
      window.api.testWebhook(url, method, {}, null).then(showTestResult);
    });

    document.getElementById('test-off-btn').addEventListener('click', () => {
      const url = offUrlInput().value.trim();
      const method = offMethodSelect().value;
      window.api.testWebhook(url, method, {}, null).then(showTestResult);
    });

    document.getElementById('test-keys-btn').addEventListener('click', () => {
      if (!currentKeys) {
        StatusBar.addEntry('No keys configured', false);
        return;
      }
      window.api.testKeypress(currentKeys).then(showTestResult);
    });

    const shellyScanBtn = document.getElementById('shelly-scan-btn');
    shellyScanBtn.addEventListener('click', async () => {
      shellyScanBtn.disabled = true;
      shellyScanBtn.textContent = 'Scanning...';
      shellyBleStatusEl().textContent = 'Scanning for Shelly devices...';
      shellyBleStatusEl().className = 'form-hint ble-scanning';
      try {
        const name = await ShellyBle.scan();
        if (name) {
          currentShellyDeviceName = name;
          shellyDeviceNameInput().value = name;
          updateShellyStatus();
          StatusBar.addEntry(`Connected to ${name}`, true);
        } else {
          shellyBleStatusEl().textContent = 'No device selected';
          shellyBleStatusEl().className = 'form-hint';
        }
      } catch (err) {
        shellyBleStatusEl().textContent = 'Scan failed';
        shellyBleStatusEl().className = 'form-hint status-disconnected';
        StatusBar.addEntry(`BLE scan failed: ${err.message}`, false);
      } finally {
        shellyScanBtn.disabled = false;
        shellyScanBtn.textContent = 'Scan & Connect';
      }
    });

    document.getElementById('test-shelly-btn').addEventListener('click', async () => {
      if (!currentShellyDeviceName) {
        StatusBar.addEntry('No Shelly device connected', false);
        return;
      }
      try {
        const compId = parseInt(shellyComponentIdInput().value, 10) || 0;
        const result = await ShellyBle.switchToggle(currentShellyDeviceName, compId);
        StatusBar.addEntry(`Shelly toggle OK: was_on=${result && result.result ? result.result.was_on : '?'}`, true);
      } catch (err) {
        StatusBar.addEntry(`Shelly toggle failed: ${err.message}`, false);
      }
    });

    document.querySelector('.modal-close').addEventListener('click', close);
    document.querySelector('.modal-backdrop').addEventListener('click', close);
    document.getElementById('modal-cancel').addEventListener('click', close);

    document.getElementById('modal-save').addEventListener('click', () => {
      const data = collectActionData();
      if (!data) {
        if (!nameInput().value.trim()) {
          nameInput().focus();
          flashError(nameInput());
        } else if (typeSelect().value === 'keypress' && !currentKeys) {
          flashError(keysDisplay());
        } else if (typeSelect().value === 'shelly-ble' && !currentShellyDeviceName) {
          flashError(shellyDeviceNameInput());
        }
        return;
      }
      if (onSaveCallback) {
        onSaveCallback(data, currentActionIndex);
      }
      close();
    });

    document.getElementById('modal-delete').addEventListener('click', () => {
      if (onDeleteCallback && currentActionIndex >= 0) {
        onDeleteCallback(currentActionIndex);
      }
      close();
    });
  }

  function flashError(el) {
    el.style.borderColor = 'var(--danger)';
    setTimeout(() => {
      el.style.borderColor = '';
    }, 1500);
  }

  function showTestResult(result) {
    const msg = result.success
      ? `Test OK${result.status != null ? ' (HTTP ' + result.status + ')' : result.detail ? ' (' + result.detail + ')' : ''}`
      : `Test FAILED: ${result.detail}`;
    StatusBar.addEntry(msg, result.success);
  }

  return { open, close, isOpen, handleMidiLearn, initEvents };
})();

const StatusBar = (() => {
  const log = () => document.getElementById('status-log');
  const MAX_ENTRIES = 5;

  function addEntry(message, success) {
    const el = document.createElement('span');
    el.className = `status-entry ${success ? 'success' : 'fail'}`;
    const time = new Date().toLocaleTimeString();
    el.textContent = `[${time}] ${message}`;

    const logEl = log();
    logEl.insertBefore(el, logEl.firstChild);

    while (logEl.children.length > MAX_ENTRIES) {
      logEl.removeChild(logEl.lastChild);
    }
  }

  return { addEntry };
})();
