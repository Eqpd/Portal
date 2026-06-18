/**
 * electron-builder configuration
 *
 * Required environment variables for release builds:
 *
 *   macOS signing + notarization:
 *     CSC_NAME             — Developer ID Application cert name from Keychain
 *     APPLE_ID             — Apple ID email for the Developer account
 *     APPLE_ID_PASSWORD    — App-specific password (appleid.apple.com)
 *     APPLE_TEAM_ID        — 10-char team ID from developer.apple.com
 *
 *   Windows signing:
 *     WIN_CSC_LINK         — Path or URL to the .pfx certificate file
 *     WIN_CSC_KEY_PASSWORD — Password for the .pfx file
 *
 *   Publishing (GitHub Releases):
 *     GH_TOKEN             — GitHub personal access token (repo scope)
 *     GH_OWNER             — GitHub org/user that owns the release repo
 *     GH_REPO              — GitHub repo name for releases
 */

module.exports = {
  appId: 'nz.equip.portal2',
  productName: 'Equip Portal',
  directories: { output: 'dist' },

  publish: [
    {
      provider: 'github',
      owner: 'Eqpd',
      repo: 'Portal',
      private: true,
    },
  ],

  mac: {
    category: 'public.app-category.utilities',
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    identity: process.env.CSC_NAME || null,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: false,
  },

  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
    ],
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
