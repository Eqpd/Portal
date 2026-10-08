const { notarize } = require('@electron/notarize');

module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') return;

  const isSigning = !!process.env.CSC_NAME || !!process.env.CSC_LINK;

  if (!isSigning) {
    console.log('[notarize] No signing identity set — skipping notarization (dev build).');
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_ID_PASSWORD;
  const appleTeamId = process.env.APPLE_TEAM_ID;

  const missing = [];
  if (!appleId) missing.push('APPLE_ID');
  if (!appleIdPassword) missing.push('APPLE_ID_PASSWORD');
  if (!appleTeamId) missing.push('APPLE_TEAM_ID');

  if (missing.length > 0) {
    throw new Error(
      `[notarize] A signing identity (CSC_NAME) is set but notarization ` +
      `credentials are missing: ${missing.join(', ')}. ` +
      `Set these environment variables or remove CSC_NAME to do an unsigned build.`
    );
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[notarize] Submitting ${appPath} to Apple notary service…`);

  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId: appleTeamId,
  });

  console.log('[notarize] Notarization complete.');
};
