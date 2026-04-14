class ActionDispatcher {
  constructor(timeoutMs = 5000, keySender = null) {
    this.timeoutMs = timeoutMs;
    this.keySender = keySender;
    this.onStatus = null;
    // Map<actionId, Set<ccNumber>> — which CCs are currently "on" for each action
    this.triggerState = new Map();
    // Map<actionId, timestamp> — last time this action fired (for debounce)
    this.lastFireTime = new Map();
  }

  handleCC(channel, controller, value, config) {
    const channelMatch =
      config.midiChannel === null || config.midiChannel === channel;
    if (!channelMatch) return;

    for (const action of config.actions) {
      const trigger = action.triggers.find((t) => t.ccNumber === controller);
      if (!trigger) continue;

      const threshold = trigger.threshold != null ? trigger.threshold : 1;
      const isAbove = value >= threshold;

      if (!this.triggerState.has(action.id)) {
        this.triggerState.set(action.id, new Set());
      }
      const activeSet = this.triggerState.get(action.id);
      const wasOn = activeSet.size > 0;

      if (isAbove) {
        activeSet.add(controller);
      } else {
        activeSet.delete(controller);
      }

      const isOn = activeSet.size > 0;

      if (isOn && !wasOn) {
        this.fire(action, true);
      } else if (!isOn && wasOn) {
        this.fire(action, false);
      }
    }
  }

  async fire(action, isOn) {
    switch (action.type) {
      case 'webhook':
        return this.fireWebhook(action, isOn);
      case 'keypress':
        return this.fireKeypress(action, isOn);
      default:
        console.warn(`Unknown action type: ${action.type}`);
    }
  }

  async fireKeypress(action, isOn) {
    // Keypress actions only fire on ON transitions.
    if (!isOn) return;
    if (!action.keys) return;
    if (!this.keySender) {
      this.report(action.name, true, false, 'KeySender not initialized');
      return;
    }

    const debounceMs = action.debounceMs != null ? action.debounceMs : 200;
    const now = Date.now();
    const last = this.lastFireTime.get(action.id) || 0;
    if (now - last < debounceMs) {
      return;
    }
    this.lastFireTime.set(action.id, now);

    try {
      await this.keySender.send(action.keys);
      this.report(action.name, true, true, action.keys);
    } catch (err) {
      this.report(action.name, true, false, err.message);
    }
  }

  async fireWebhook(action, isOn) {
    const url = isOn ? action.onUrl : action.offUrl;
    const method = isOn ? action.onMethod || 'GET' : action.offMethod || 'GET';
    const headers = isOn ? action.onHeaders || {} : action.offHeaders || {};
    const body = isOn ? action.onBody : action.offBody;

    if (!url) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const opts = { method, headers, signal: controller.signal };
      if (body && method !== 'GET') {
        opts.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const response = await fetch(url, opts);
      this.report(action.name, isOn, true, response.status);
    } catch (err) {
      this.report(action.name, isOn, false, err.message);
    } finally {
      clearTimeout(timeout);
    }
  }

  async testWebhook(url, method, headers, body) {
    if (!url) return { success: false, detail: 'No URL provided' };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const opts = {
        method: method || 'GET',
        headers: headers || {},
        signal: controller.signal,
      };
      if (body && method !== 'GET') {
        opts.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const response = await fetch(url, opts);
      return { success: true, status: response.status };
    } catch (err) {
      return { success: false, detail: err.message };
    } finally {
      clearTimeout(timeout);
    }
  }

  async testKeypress(keys) {
    if (!keys) return { success: false, detail: 'No key combo provided' };
    if (!this.keySender) return { success: false, detail: 'KeySender not initialized' };
    try {
      await this.keySender.send(keys);
      return { success: true, detail: keys };
    } catch (err) {
      return { success: false, detail: err.message };
    }
  }

  report(name, isOn, success, detail) {
    if (this.onStatus) {
      this.onStatus({ name, isOn, success, detail, timestamp: Date.now() });
    }
  }

  resetState() {
    this.triggerState.clear();
  }
}

module.exports = { ActionDispatcher };
