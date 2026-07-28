/**
 * electron-builder configuration
 */

module.exports = {
  appId: 'nz.equip.portal2',
  productName: 'Equip Portal',
  icon: 'build/icon',
  directories: { output: 'dist' },

  publish: [
    {
      provider: 'github',
      owner: 'Eqpd',
      repo: 'Portal',
      private: false,
    },
  ],

  mac: {
    category: 'public.app-category.utilities',
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    identity: process.env.CSC_NAME || null,
    hardenedRuntime: !!process.env.CSC_NAME,
    gatekeeperAssess: false,
    notarize: false,
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    certificateFile: process.env.WIN_CSC_LINK || null,
    certificatePassword: process.env.WIN_CSC_KEY_PASSWORD || null,
    signingHashAlgorithms: ['sha256'],
    verifyUpdateCodeSignature: true,
    publisherName: 'Equip Systems',
  },

  nsis: {
    oneClick: true,
    perMachine: true,
    allowToChangeInstallationDirectory: false,
    deleteAppDataOnUninstall: false,
  },

  linux: { target: 'AppImage' },

  files: [
    'main.js',
    'preload.js',
    'renderer/**',
    'local-server/**',
    'sync/**',
    'config.json',
    'node_modules/**',
  ],

  extraResources: [
    { from: 'renderer', to: 'renderer' },
  ],
};
