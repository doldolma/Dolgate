const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { notarize } = require('@electron/notarize');
const { sign } = require('@electron/osx-sign');

const execFileAsync = promisify(execFile);

function isEnabled(value) {
  return value === '1' || value === 'true';
}

async function execSecurity(args, options = {}) {
  return execFileAsync('/usr/bin/security', args, options);
}

function decodeBase64File(value, outputPath) {
  return fs.writeFile(outputPath, Buffer.from(value, 'base64'), { mode: 0o600 });
}

async function listUserKeychains() {
  const { stdout } = await execSecurity(['list-keychains', '-d', 'user']);
  return stdout
    .split('\n')
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

async function createSigningKeychain(tempDir) {
  const { CSC_LINK, CSC_KEY_PASSWORD } = process.env;
  if (!CSC_LINK) {
    return { keychain: undefined, cleanup: async () => {} };
  }
  if (!CSC_KEY_PASSWORD) {
    throw new Error('CSC_KEY_PASSWORD secret is required when CSC_LINK is set.');
  }

  const previousKeychains = await listUserKeychains();
  const keychainPassword = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const keychain = path.join(tempDir, 'dolgate-signing.keychain-db');
  const p12Path = existsSync(CSC_LINK) ? CSC_LINK : path.join(tempDir, 'developer-id.p12');

  if (!existsSync(CSC_LINK)) {
    await decodeBase64File(CSC_LINK, p12Path);
  }

  await execSecurity(['create-keychain', '-p', keychainPassword, keychain]);
  await execSecurity(['unlock-keychain', '-p', keychainPassword, keychain]);
  await execSecurity(['set-keychain-settings', '-lut', '21600', keychain]);
  await execSecurity(['list-keychains', '-d', 'user', '-s', keychain, ...previousKeychains]);
  await execSecurity([
    'import',
    p12Path,
    '-k',
    keychain,
    '-P',
    CSC_KEY_PASSWORD,
    '-T',
    '/usr/bin/codesign',
    '-T',
    '/usr/bin/security'
  ]);
  await execSecurity(['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, keychain]);

  return {
    keychain,
    cleanup: async () => {
      await execSecurity(['list-keychains', '-d', 'user', '-s', ...previousKeychains]).catch(() => {});
      await execSecurity(['delete-keychain', keychain]).catch(() => {});
    }
  };
}

async function resolveAppleApiKey(tempDir) {
  if (process.env.APPLE_API_KEY) {
    return { path: process.env.APPLE_API_KEY, cleanup: async () => {} };
  }

  const { APPLE_API_KEY_BASE64, APPLE_API_KEY_ID } = process.env;
  if (!APPLE_API_KEY_BASE64 || !APPLE_API_KEY_ID) {
    return null;
  }

  const keyPath = path.join(tempDir, `AuthKey_${APPLE_API_KEY_ID}.p8`);
  await decodeBase64File(APPLE_API_KEY_BASE64, keyPath);
  return { path: keyPath, cleanup: async () => {} };
}

async function notarizeApp(appPath, tempDir) {
  const { APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  const apiKey = await resolveAppleApiKey(tempDir);
  if (apiKey && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    await notarize({
      appPath,
      appleApiKey: apiKey.path,
      appleApiKeyId: APPLE_API_KEY_ID,
      appleApiIssuer: APPLE_API_ISSUER
    });
    return;
  }

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
    await notarize({
      appPath,
      appleId: APPLE_ID,
      appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
      teamId: APPLE_TEAM_ID
    });
    return;
  }

  if (isEnabled(process.env.DOLGATE_SKIP_MAC_NOTARIZE)) {
    console.log('[sign-notarize] Skip notarization because DOLGATE_SKIP_MAC_NOTARIZE is set.');
    return;
  }

  throw new Error('Apple notarization credentials are missing.');
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('[sign-notarize] Skip macOS signing because the current platform is not darwin.');
    return;
  }

  const appPath = path.resolve(process.argv[2] ?? 'out/dolgate-darwin-universal/dolgate.app');
  if (!existsSync(appPath)) {
    throw new Error(`macOS app bundle not found: ${appPath}`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dolgate-sign-notarize-'));
  const signingKeychain = await createSigningKeychain(tempDir);
  try {
    await sign({
      app: appPath,
      platform: 'darwin',
      type: 'distribution',
      keychain: signingKeychain.keychain,
      identity: process.env.MAC_CODESIGN_IDENTITY || process.env.CSC_NAME,
      identityValidation: false,
      hardenedRuntime: true
    });
    await notarizeApp(appPath, tempDir);
    console.log(`[sign-notarize] Signed and notarized ${appPath}`);
  } finally {
    await signingKeychain.cleanup();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
