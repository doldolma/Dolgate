const { test, expect, _electron: electron } = require('@playwright/test');
const electronPath = require('electron');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const desktopMainPath = path.resolve(__dirname, '../.vite/build/main.js');
const timestamp = '2025-01-01T00:00:00.000Z';

async function writeDesktopState(userDataDir) {
  const storageDir = path.join(userDataDir, 'storage');
  await mkdir(storageDir, { recursive: true });
  await writeFile(
    path.join(storageDir, 'state.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        settings: {
          theme: 'system',
          updatedAt: timestamp
        },
        terminal: {
          globalThemeId: 'dolssh-dark',
          globalThemeUpdatedAt: timestamp,
          fontFamily: 'sf-mono',
          fontSize: 13,
          localUpdatedAt: timestamp
        },
        updater: {
          dismissedVersion: null,
          updatedAt: timestamp
        },
        auth: {
          status: 'authenticated',
          updatedAt: timestamp
        },
        sync: {
          lastSuccessfulSyncAt: null,
          pendingPush: false,
          errorMessage: null,
          updatedAt: timestamp
        },
        data: {
          groups: [
            {
              id: 'group-1',
              name: 'Production',
              path: 'Production',
              parentPath: null,
              createdAt: timestamp,
              updatedAt: timestamp
            }
          ],
          hosts: [
            {
              id: 'aws-1',
              kind: 'aws-ec2',
              label: 'Smoke AWS',
              awsProfileName: 'default',
              awsRegion: 'ap-northeast-2',
              awsInstanceId: 'i-smoke-test',
              awsInstanceName: 'smoke',
              awsPlatform: 'linux',
              awsPrivateIp: '10.0.0.10',
              awsState: 'running',
              groupName: 'Production',
              tags: ['smoke'],
              terminalThemeId: null,
              createdAt: timestamp,
              updatedAt: timestamp
            },
            {
              id: 'ssh-1',
              kind: 'ssh',
              label: 'Smoke SSH',
              hostname: 'prod.example.com',
              port: 22,
              username: 'ubuntu',
              authType: 'password',
              privateKeyPath: null,
              secretRef: null,
              groupName: 'Production',
              tags: ['smoke'],
              terminalThemeId: null,
              createdAt: timestamp,
              updatedAt: timestamp
            }
          ],
          knownHosts: [],
          portForwards: [],
          secretMetadata: [],
          syncOutbox: []
        },
        secure: {
          refreshToken: null,
          managedSecretsByRef: {}
        }
      },
      null,
      2
    ),
    'utf8'
  );
}

function createFakeAuthSessionJson() {
  return JSON.stringify({
    user: {
      id: 'user-smoke',
      email: 'smoke@example.com'
    },
    tokens: {
      accessToken: 'smoke-access-token',
      refreshToken: 'smoke-refresh-token',
      expiresInSeconds: 900
    },
    vaultBootstrap: {
      keyBase64: Buffer.alloc(32, 1).toString('base64')
    },
    syncServerTime: timestamp
  });
}

async function launchDesktop(env) {
  const mergedEnv = Object.fromEntries(
    Object.entries({
      ...process.env,
      ...env
    }).filter((entry) => typeof entry[1] === 'string')
  );

  return electron.launch({
    executablePath: electronPath,
    args: [desktopMainPath],
    env: mergedEnv
  });
}

test.describe('desktop smoke', () => {
  test('shows the login gate when no session is bootstrapped', async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'dolssh-smoke-login-'));
    const app = await launchDesktop({
      DOLSSH_USER_DATA_DIR: userDataDir
    });

    try {
      const page = await app.firstWindow();
      await expect(page.getByRole('button', { name: '브라우저로 로그인하기' })).toBeVisible();
    } finally {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test('boots into home, switches sections, opens a fake AWS tab, and renders the SFTP workspace', async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'dolssh-smoke-home-'));
    await writeDesktopState(userDataDir);

    const app = await launchDesktop({
      DOLSSH_USER_DATA_DIR: userDataDir,
      DOLSSH_E2E_AUTH_SESSION_JSON: createFakeAuthSessionJson(),
      DOLSSH_E2E_DISABLE_SYNC: '1',
      DOLSSH_E2E_FAKE_AWS_SESSION: '1'
    });

    try {
      const page = await app.firstWindow();
      const homeNavigation = page.getByRole('navigation', { name: 'Home navigation' });

      await expect(homeNavigation.getByRole('button', { name: '▣ Hosts' })).toBeVisible();
      await expect(page.getByText('Smoke AWS')).toBeVisible();

      await homeNavigation.getByRole('button', { name: '⇄ Port Forwarding' }).click();
      await expect(page.getByRole('heading', { name: 'Port Forwarding' })).toBeVisible();

      await homeNavigation.getByRole('button', { name: '◌ Settings' }).click();
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

      await homeNavigation.getByRole('button', { name: '▣ Hosts' }).click();
      const smokeAwsCard = page.locator('.host-browser-card').filter({ hasText: 'Smoke AWS' }).first();
      await expect(smokeAwsCard).toBeVisible();
      await smokeAwsCard.dblclick();
      await expect(page.getByRole('button', { name: /Smoke AWS(?: \\(\\d+\\))? 세션 종료/ })).toBeVisible({ timeout: 10_000 });

      await page.getByRole('button', { name: 'SFTP' }).click();
      await expect(page.getByRole('heading', { name: 'Host', exact: true })).toBeVisible();
      await expect(page.getByPlaceholder('Search hosts...')).toBeVisible();
      await expect(page.locator('.sftp-host-picker .group-card').filter({ hasText: 'Production' }).first()).toBeVisible();
      await page.locator('.sftp-host-picker .group-card').filter({ hasText: 'Production' }).first().click();
      await expect(page.locator('.sftp-host-picker .host-browser-card').filter({ hasText: 'Smoke SSH' }).first()).toBeVisible();
    } finally {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
