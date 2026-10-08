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
  icon: 'build/icon',
  directories: { output: 'dist' },

  publish: [
    {
      provider: 'github',
      owner: process.env.GH_OWNER || 'Eqpd',
      repo: process.env.GH_REPO || 'Portal',
      private: false,
    },
  ],

  mac: {
    category: 'public.app-category.utilities',
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    // Ad-hoc signing works without an Apple Developer account, but does not
    // grant Developer ID trust or notarisation. First launch needs approval.
    identity: process.env.CSC_NAME || '-',
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    hardenedRuntime: !!process.env.CSC_NAME,
    gatekeeperAssess: false,
    notarize: false,
  },

  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
    ],
    ...(process.env.WIN_CSC_LINK ? {
      signtoolOptions: {
        certificateFile: process.env.WIN_CSC_LINK,
        certificatePassword: process.env.WIN_CSC_KEY_PASSWORD || undefined,
        signingHashAlgorithms: ['sha256'],
        publisherName: 'Equip Systems',
      },
    } : {}),
    // Unsigned test installers cannot pass Authenticode verification.
    // electron-updater still verifies the release's SHA-512 checksum.
    verifyUpdateCodeSignature: !!process.env.WIN_CSC_LINK,
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
    'unsigned-mac-updater.js',
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
