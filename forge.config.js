module.exports = {
  packagerConfig: {
    name: 'MIDI Hooks',
    icon: './assets/icon',
    asar: true,
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-dmg', platforms: ['darwin'], config: {} },
    { name: '@electron-forge/maker-zip', platforms: ['linux'] },
    { name: '@electron-forge/maker-squirrel', config: {} },
  ],
};
