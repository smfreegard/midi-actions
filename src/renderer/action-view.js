/* global */

const ActionView = (() => {
  const grid = () => document.getElementById('action-grid');
  const emptyState = () => document.getElementById('empty-state');

  // Track current CC values for display
  const ccValues = new Map();

  function render(config, onEdit) {
    const g = grid();
    g.innerHTML = '';

    if (config.actions.length === 0) {
      emptyState().classList.remove('hidden');
      return;
    }
    emptyState().classList.add('hidden');

    config.actions.forEach((action, index) => {
      g.appendChild(createCard(action, index, onEdit));
    });
  }

  function createCard(action, index, onEdit) {
    const card = document.createElement('div');
    const bleDisconnected = action.type === 'shelly-ble' && action.shellyDeviceName &&
      (typeof ShellyBle === 'undefined' || !ShellyBle.isConnected(action.shellyDeviceName));
    card.className = 'action-card' + (action.enabled === false || bleDisconnected ? ' disabled' : '');
    card.dataset.actionId = action.id;
    card.dataset.index = index;

    const triggerList = action.triggers
      .map((t) => {
        const key = t.channel != null ? `${t.channel}:${t.ccNumber}` : `*:${t.ccNumber}`;
        const val = ccValues.get(key);
        const valStr = val != null ? val : '--';
        const chLabel = t.channel != null ? ` ch${t.channel + 1}` : '';
        return `<span class="trigger-badge" data-cc="${t.ccNumber}" data-ch="${t.channel != null ? t.channel : ''}">CC ${t.ccNumber}${chLabel} <span class="trigger-value">${valStr}</span></span>`;
      })
      .join('');

    let detail = '';
    if (action.type === 'keypress' && action.keys) {
      detail = `<div class="action-detail">&#9000; ${escapeHtml(action.keys)}</div>`;
    } else if (action.type === 'webhook' && action.onUrl) {
      const m = action.onMethod || 'GET';
      detail = `<div class="action-detail">${escapeHtml(m)} ${escapeHtml(truncateUrl(action.onUrl))}</div>`;
    } else if (action.type === 'shelly-ble' && action.shellyDeviceName) {
      const bleConnected = typeof ShellyBle !== 'undefined' && ShellyBle.isConnected(action.shellyDeviceName);
      const bleStatus = bleConnected
        ? '<span class="ble-connected">connected</span>'
        : '<span class="ble-disconnected">disconnected</span>';
      detail = `<div class="action-detail">BLE: ${escapeHtml(action.shellyDeviceName)} ${bleStatus}</div>`;
    }

    card.innerHTML = `
      <div class="action-name">${escapeHtml(action.name || 'Unnamed')}</div>
      <div class="action-state off">OFF</div>
      ${detail}
      <div class="action-triggers">${triggerList || '<span class="no-triggers">No triggers</span>'}</div>
    `;

    card.addEventListener('click', () => onEdit(index));
    return card;
  }

  function updateCC(channel, ccNumber, value) {
    // Cache keyed by "channel:cc" for channel-specific triggers,
    // and also by "*:cc" so channel-agnostic triggers update too.
    ccValues.set(`${channel}:${ccNumber}`, value);
    ccValues.set(`*:${ccNumber}`, value);

    // Update trigger badges that match this CC and (this channel or any channel)
    const badges = document.querySelectorAll(`.trigger-badge[data-cc="${ccNumber}"]`);
    badges.forEach((badge) => {
      const badgeCh = badge.dataset.ch;
      // Match if badge has no channel (any) or matches this channel
      if (badgeCh === '' || parseInt(badgeCh, 10) === channel) {
        const valEl = badge.querySelector('.trigger-value');
        if (valEl) valEl.textContent = value;
      }
    });
  }

  function updateActionState(actionId, isOn) {
    const cards = document.querySelectorAll(`.action-card[data-action-id="${actionId}"]`);
    cards.forEach((card) => {
      const stateEl = card.querySelector('.action-state');
      stateEl.textContent = isOn ? 'ON' : 'OFF';
      stateEl.className = 'action-state ' + (isOn ? 'on' : 'off');
      card.classList.toggle('active', isOn);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function truncateUrl(url) {
    if (url.length <= 38) return url;
    return url.slice(0, 35) + '...';
  }

  return { render, updateCC, updateActionState };
})();
