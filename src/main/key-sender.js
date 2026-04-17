const { spawn } = require('child_process');

/**
 * Parses a canonical key combo like "ctrl+shift+f5" into { modifiers: [...], key: "..." }.
 * Modifiers: ctrl, shift, alt, meta
 * Case-insensitive. Throws on invalid combos.
 */
function parseCombo(combo) {
  if (!combo || typeof combo !== 'string') {
    throw new Error('Empty key combo');
  }
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('Empty key combo');

  const modifiers = new Set();
  let key = null;
  const validMods = new Set(['ctrl', 'shift', 'alt', 'meta']);

  for (const p of parts) {
    if (validMods.has(p)) {
      modifiers.add(p);
    } else {
      if (key !== null) throw new Error(`Multiple non-modifier keys in combo: ${combo}`);
      key = p;
    }
  }
  if (!key) throw new Error(`Combo has no non-modifier key: ${combo}`);
  return { modifiers: [...modifiers], key };
}

// ======================================================================
// Windows: persistent PowerShell using Win32 keybd_event via P/Invoke.
// SendKeys is unreliable under rapid fire — inherits stuck modifier state
// from prior events, causing random Ctrl+X outputs. keybd_event gives us
// deterministic key press/release control.
// ======================================================================

// Windows Virtual-Key codes
const VK = {
  // modifiers
  ctrl: 0x11, shift: 0x10, alt: 0x12, meta: 0x5B,
  // special keys
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  enter: 0x0D, return: 0x0D,
  escape: 0x1B, esc: 0x1B,
  tab: 0x09, space: 0x20,
  backspace: 0x08, delete: 0x2E,
  home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22,
};

function winKeyVk(key) {
  if (VK[key] !== undefined) return VK[key];
  if (/^[a-z]$/.test(key)) return key.toUpperCase().charCodeAt(0); // A-Z = 0x41-0x5A
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0); // 0-9 = 0x30-0x39
  if (/^f([1-9]|1[0-2])$/.test(key)) {
    const n = parseInt(key.slice(1), 10);
    return 0x70 + (n - 1); // F1 = 0x70 … F12 = 0x7B
  }
  return null;
}

function winTranslate(combo) {
  const { modifiers, key } = parseCombo(combo);
  const vk = winKeyVk(key);
  if (vk === null) throw new Error(`Unsupported key: ${key}`);

  const modVks = [];
  if (modifiers.includes('ctrl')) modVks.push(VK.ctrl);
  if (modifiers.includes('shift')) modVks.push(VK.shift);
  if (modifiers.includes('alt')) modVks.push(VK.alt);
  if (modifiers.includes('meta')) modVks.push(VK.meta);

  return { vk, modVks };
}

class WindowsKeySender {
  constructor() {
    this.proc = null;
    this.ready = false;
    this._queue = [];
  }

  _ensureProc() {
    if (this.proc && !this.proc.killed) return;
    this.proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '-'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    this.ready = false;
    this.proc.stderr.on('data', (d) =>
      console.error('[key-sender] powershell stderr:', d.toString())
    );
    this.proc.on('exit', (code) => {
      console.warn(`[key-sender] powershell exited (code ${code})`);
      this.proc = null;
      this.ready = false;
    });

    // Build setup script as single-line semicolon-separated commands.
    // Use PowerShell single-quoted string for the C# so embedded double
    // quotes pass through literally (PS double-quoted strings use ""
    // for escaping, not \").
    const csharp =
      'using System;using System.Runtime.InteropServices;' +
      'public class KP{' +
      '[DllImport("user32.dll")]' +
      'public static extern void keybd_event(byte bVk,byte bScan,uint dwFlags,UIntPtr dwExtraInfo);' +
      '}';
    const setup =
      `Add-Type -TypeDefinition '${csharp}';` +
      `function Send-Keys([int[]]$mods,[int]$vk){` +
      // Pre-release all modifiers to prevent physical keyboard state
      // from leaking into the synthetic keystroke (e.g. user holding
      // Ctrl would make synthetic 'a' become Ctrl+A).
      `[KP]::keybd_event(0x11,0,2,[UIntPtr]::Zero);` + // release Ctrl
      `[KP]::keybd_event(0x10,0,2,[UIntPtr]::Zero);` + // release Shift
      `[KP]::keybd_event(0x12,0,2,[UIntPtr]::Zero);` + // release Alt
      `[KP]::keybd_event(0x5B,0,2,[UIntPtr]::Zero);` + // release LWin
      `[KP]::keybd_event(0x5C,0,2,[UIntPtr]::Zero);` + // release RWin
      `foreach($m in $mods){[KP]::keybd_event([byte]$m,0,0,[UIntPtr]::Zero)};` +
      `[KP]::keybd_event([byte]$vk,0,0,[UIntPtr]::Zero);` +
      `[KP]::keybd_event([byte]$vk,0,2,[UIntPtr]::Zero);` +
      `for($i=$mods.Length-1;$i -ge 0;$i--){[KP]::keybd_event([byte]$mods[$i],0,2,[UIntPtr]::Zero)}` +
      `};` +
      `Write-Output READY\r\n`;

    this.proc.stdin.write(setup);
    this.proc.stdout.on('data', (d) => {
      const text = d.toString();
      console.log('[key-sender] stdout:', text.trim());
      if (!this.ready && text.includes('READY')) {
        console.log('[key-sender] ready; flushing', this._queue.length, 'queued');
        this.ready = true;
        while (this._queue.length) {
          this.proc.stdin.write(this._queue.shift());
        }
      }
    });
  }

  start() {
    this._ensureProc();
  }

  async send(combo) {
    this._ensureProc();
    const { vk, modVks } = winTranslate(combo);
    const modsArg = modVks.length ? `@(${modVks.join(',')})` : '@()';
    const cmd = `Send-Keys ${modsArg} ${vk}\r\n`;
    console.log('[key-sender] send', combo, '->', cmd.trim(), 'ready=', this.ready);
    if (this.ready) {
      this.proc.stdin.write(cmd);
    } else {
      this._queue.push(cmd);
    }
  }

  shutdown() {
    if (this.proc) {
      try { this.proc.stdin.end(); } catch (_) {}
      try { this.proc.kill(); } catch (_) {}
      this.proc = null;
      this.ready = false;
    }
  }
}

// ======================================================================
// macOS: persistent osascript with AppleScript System Events
// ======================================================================

// AppleScript key codes for non-character keys. See
// https://eastmanreference.com/complete-list-of-applescript-key-codes
const MAC_KEY_CODES = {
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  enter: 36,
  return: 36,
  escape: 53,
  esc: 53,
  tab: 48,
  space: 49,
  backspace: 51,
  delete: 117,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

function macTranslate(combo) {
  const { modifiers, key } = parseCombo(combo);
  const usingParts = [];
  if (modifiers.includes('ctrl')) usingParts.push('control down');
  if (modifiers.includes('shift')) usingParts.push('shift down');
  if (modifiers.includes('alt')) usingParts.push('option down');
  if (modifiers.includes('meta')) usingParts.push('command down');

  const using = usingParts.length
    ? ` using {${usingParts.join(', ')}}`
    : '';

  if (MAC_KEY_CODES[key] !== undefined) {
    return `tell application "System Events" to key code ${MAC_KEY_CODES[key]}${using}`;
  }
  if (/^[a-z0-9]$/.test(key)) {
    return `tell application "System Events" to keystroke "${key}"${using}`;
  }
  throw new Error(`Unsupported key: ${key}`);
}

class MacKeySender {
  constructor() {
    this.proc = null;
  }

  _ensureProc() {
    if (this.proc && !this.proc.killed) return;
    // osascript -i reads one AppleScript statement per line from stdin
    this.proc = spawn('osascript', ['-i'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stderr.on('data', (d) =>
      console.error('[key-sender] osascript stderr:', d.toString())
    );
    this.proc.on('exit', (code) => {
      console.warn(`[key-sender] osascript exited (code ${code})`);
      this.proc = null;
    });
  }

  start() {
    this._ensureProc();
  }

  async send(combo) {
    this._ensureProc();
    const script = macTranslate(combo);
    this.proc.stdin.write(script + '\n');
  }

  shutdown() {
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch (_) {}
      try {
        this.proc.kill();
      } catch (_) {}
      this.proc = null;
    }
  }
}

// ======================================================================
// Linux: xdotool, one-shot per call (already fast)
// ======================================================================

function linuxTranslate(combo) {
  const { modifiers, key } = parseCombo(combo);
  const parts = [];
  if (modifiers.includes('ctrl')) parts.push('ctrl');
  if (modifiers.includes('shift')) parts.push('shift');
  if (modifiers.includes('alt')) parts.push('alt');
  if (modifiers.includes('meta')) parts.push('super');

  const xKey = ({
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    enter: 'Return',
    return: 'Return',
    escape: 'Escape',
    esc: 'Escape',
    tab: 'Tab',
    space: 'space',
    backspace: 'BackSpace',
    delete: 'Delete',
    home: 'Home',
    end: 'End',
    pageup: 'Page_Up',
    pagedown: 'Page_Down',
  })[key] || (
    /^f([1-9]|1[0-2])$/.test(key)
      ? key.toUpperCase()
      : /^[a-z0-9]$/.test(key)
        ? key
        : null
  );
  if (!xKey) throw new Error(`Unsupported key: ${key}`);
  parts.push(xKey);
  return parts.join('+');
}

class LinuxKeySender {
  start() {
    // no-op; spawn-per-call is already fast
  }

  async send(combo) {
    const arg = linuxTranslate(combo);
    return new Promise((resolve, reject) => {
      const p = spawn('xdotool', ['key', arg]);
      let stderr = '';
      p.stderr.on('data', (d) => (stderr += d.toString()));
      p.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `xdotool exited with code ${code}`));
      });
      p.on('error', reject);
    });
  }

  shutdown() {
    // no-op
  }
}

// ======================================================================
// Facade
// ======================================================================

class KeySender {
  constructor() {
    if (process.platform === 'win32') {
      this.impl = new WindowsKeySender();
    } else if (process.platform === 'darwin') {
      this.impl = new MacKeySender();
    } else {
      this.impl = new LinuxKeySender();
    }
  }

  start() {
    this.impl.start();
  }

  async send(combo) {
    return this.impl.send(combo);
  }

  shutdown() {
    this.impl.shutdown();
  }
}

module.exports = { KeySender, parseCombo };
