const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { notarize } = require('@electron/notarize');

async function resolveAppleApiKey() {
  if (process.env.APPLE_API_KEY) {
    return { path: process.env.APPLE_API_KEY, cleanup: async () => {} };
  }

  const { APPLE_API_KEY_BASE64, APPLE_API_KEY_ID } = process.env;
  if (!APPLE_API_KEY_BASE64 || !APPLE_API_KEY_ID) {
    return null;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dolgate-notary-'));
  const keyPath = path.join(tempDir, `AuthKey_${APPLE_API_KEY_ID}.p8`);
  await fs.writeFile(keyPath, Buffer.from(APPLE_API_KEY_BASE64, 'base64'), { mode: 0o600 });
  return {
    path: keyPath,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  };
}

module.exports = async function notarizeApp(context) {
  if (process.platform !== 'darwin') {
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const { APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  const apiKey = await resolveAppleApiKey();
  if (apiKey && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    try {
      await notarize({
        appPath,
        appleApiKey: apiKey.path,
        appleApiKeyId: APPLE_API_KEY_ID,
        appleApiIssuer: APPLE_API_ISSUER
      });
    } finally {
      await apiKey.cleanup();
    }
    return;
  }

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] Skip notarization because Apple credentials are missing.');
    return;
  }

  await notarize({
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID
  });
};
