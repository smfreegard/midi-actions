# MIDI Hooks

A cross-platform Electron app that receives MIDI CC signals from any MIDI controller and triggers configurable actions (HTTP webhooks or keystrokes) when values cross a threshold.

**Use cases:** Toggle an "On Air" light via a Shelly smart plug, send hotkeys to OBS/DAW when a fader moves, trigger Home Assistant automations from hardware controls.

## Features

- **Action-centric design** - define named actions, assign one or more MIDI CC triggers to each
- **Two action types:**
  - **Webhook** - HTTP GET/POST/PUT to any URL (ON and OFF endpoints)
  - **Keypress** - send keyboard shortcuts to the focused application (cross-platform)
- **OR-logic** - when multiple CCs share an action, ON fires when the first CC crosses threshold; OFF fires only when all CCs drop below
- **MIDI Learn** - move a fader/knob/button to auto-detect its CC number
- **Key Learn** - press a key combination to capture it (e.g. Ctrl+Down)
- **Debounce** - configurable per-action debounce window for keypress actions
- **Edge detection** - actions fire only on state transitions, not on every CC message
- **System tray** - minimizes to tray with Hide/Quit dialog on close
- **Low latency keystrokes** - persistent OS helper process launched eagerly at startup

## Requirements

- Node.js 18+
- On Linux: `xdotool` for keypress actions (`sudo apt install xdotool`)
- On macOS: Accessibility permission for keypress actions (System Settings > Privacy & Security > Accessibility)

## Setup

```bash
npm install
npm start
```

## Usage

1. **Connect your MIDI device** - select it from the dropdown in the header
2. **Add an action** - click "+ Add Action"
3. **Configure the action:**
   - Set a name (e.g. "OnAirLight")
   - Choose type: **Webhook** or **Keypress**
   - For webhooks: set ON/OFF URLs and HTTP methods
   - For keypress: click **Learn Keys** and press your combo (e.g. Ctrl+Down)
4. **Assign MIDI triggers** - click **Learn** in the triggers section, then move a fader/knob/button on your controller. Multiple CCs can be assigned to one action.
5. **Test** - use the "Test" buttons to verify webhooks or keystrokes

### Shelly Smart Plug Example

For a Shelly smart plug on your local network at `192.168.1.100`:

- **ON URL:** `http://192.168.1.100/relay/0?turn=on` (GET)
- **OFF URL:** `http://192.168.1.100/relay/0?turn=off` (GET)

### Rodecaster MIDI Setup

- **RCP1:** Enable MIDI control in Settings > Advanced > Audio > Operations
- **RCP2/Duo:** SMART Pads send CC 0-7 (bank 1), CC 8-15 (bank 2), etc. on MIDI channel 1

Both devices appear as USB MIDI devices. The device name will contain "RODECaster" or "RODE" in the dropdown.

## Configuration

Config is stored in your app data directory:

- **macOS:** `~/Library/Application Support/midi-hooks/config.json`
- **Windows:** `%APPDATA%/midi-hooks/config.json`
- **Linux:** `~/.config/midi-hooks/config.json`

### Config Schema

```json
{
  "version": 2,
  "midiDeviceName": null,
  "midiChannel": null,
  "actions": [
    {
      "id": "onair-light",
      "name": "OnAirLight",
      "type": "webhook",
      "triggers": [
        { "ccNumber": 6, "threshold": 1 },
        { "ccNumber": 7, "threshold": 1 }
      ],
      "onUrl": "http://192.168.1.100/relay/0?turn=on",
      "onMethod": "GET",
      "offUrl": "http://192.168.1.100/relay/0?turn=off",
      "offMethod": "GET"
    },
    {
      "id": "scroll-down",
      "name": "ScrollDown",
      "type": "keypress",
      "triggers": [
        { "ccNumber": 8, "threshold": 1 }
      ],
      "keys": "ctrl+down",
      "debounceMs": 200
    }
  ],
  "webhookTimeoutMs": 5000,
  "minimizeToTray": true,
  "startMinimized": false
}
```

## Packaging

```bash
npm run make
```

Produces platform-specific distributables in `out/make/`:
- **macOS:** `.zip` containing ad-hoc signed `.app` bundle
- **Windows:** Squirrel installer (`.exe`)
- **Linux:** `.zip`

## Architecture

- **Main process:** Webhook dispatch, keypress dispatch (via persistent OS helper), config management, system tray
- **Renderer process:** MIDI input via Web MIDI API, action cards, configuration UI
- **IPC:** `contextBridge` with `contextIsolation: true` (no `nodeIntegration`)

### Keypress Platform Details

| Platform | Mechanism | Latency |
|---|---|---|
| Windows | Persistent `powershell.exe` with `SendKeys` | ~10-30ms (after cold start) |
| macOS | Persistent `osascript -i` with System Events | ~20-40ms |
| Linux | `xdotool` (per-call) | ~10ms |

## Future

- TCP/UDP command support
- Multiple MIDI device support
- Action profiles/presets
- GitHub Actions CI/CD for automated builds
