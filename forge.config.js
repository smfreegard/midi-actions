module.exports = {
  packagerConfig: {
    name: 'MIDI Hooks',
    icon: './assets/icon',
    asar: true,
    // Ad-hoc sign on macOS so Gatekeeper accepts the app without an Apple
    // Developer certificate. Testers still need right-click > Open the first
    // time (unsigned apps aren't notarized), but the "damaged" error is gone.
    osxSign: {
      identity: '-',
    },
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-dmg', platforms: ['darwin'], config: {} },
    { name: '@electron-forge/maker-zip', platforms: ['linux'] },
    { name: '@electron-forge/maker-squirrel', config: {} },
  ],
};
