const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { loginWithGitHubDeviceFlow } = require('./github-device-login.cjs');
const { assertGitHubOAuthConfig } = require('./github-oauth-config.cjs');

const desktopRoot = path.join(__dirname, '..');
const distDirectory = path.join(desktopRoot, 'release', 'dist');
const desktopPackage = require(path.join(desktopRoot, 'package.json'));

function parseTarget(value) {
  if (value === 'mac' || value === 'win' || value === 'all') {
    return value;
  }

  throw new Error('사용법: node ./scripts/release-publish.cjs <mac|win|all>');
}

function getTargets(target) {
  return target === 'all' ? ['mac', 'win'] : [target];
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function quoteWindowsCommandArg(value) {
  if (!value) {
    return '""';
  }

  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnOptions = {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: 'inherit'
    };

    const child =
      process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [command, ...args].map(quoteWindowsCommandArg).join(' ')], spawnOptions)
        : spawn(command, args, spawnOptions);

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} 명령이 종료 코드 ${code}로 실패했습니다.`));
    });
  });
}

async function githubRequest(config, accessToken, pathname, options = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': config.userAgent,
    'X-GitHub-Api-Version': '2022-11-28'
  };

  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`https://api.github.com${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (options.allow404 && response.status === 404) {
    return null;
  }

  if (options.expectEmpty && response.status === 204) {
    return null;
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      typeof body.message === 'string'
        ? body.message
        : `GitHub API 요청이 실패했습니다. (${response.status})`;
    throw new Error(message);
  }

  return body;
}

async function ensureRelease(config, accessToken, version) {
  const tagName = `v${version}`;
  const existing = await githubRequest(
    config,
    accessToken,
    `/repos/${config.owner}/${config.repo}/releases/tags/${encodeURIComponent(tagName)}`,
    { allow404: true }
  );

  if (existing) {
    return existing;
  }

  return githubRequest(config, accessToken, `/repos/${config.owner}/${config.repo}/releases`, {
    method: 'POST',
    body: {
      tag_name: tagName,
      name: tagName,
      draft: false,
      prerelease: false,
      generate_release_notes: true
    }
  });
}

function getContentType(filename) {
  if (filename.endsWith('.yml') || filename.endsWith('.yaml')) {
    return 'text/yaml; charset=utf-8';
  }

  if (filename.endsWith('.zip')) {
    return 'application/zip';
  }

  if (filename.endsWith('.dmg')) {
    return 'application/x-apple-diskimage';
  }

  if (filename.endsWith('.exe')) {
    return 'application/vnd.microsoft.portable-executable';
  }

  return 'application/octet-stream';
}

async function collectArtifacts() {
  const entries = await fs.readdir(distDirectory, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(distDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right));

  if (files.length === 0) {
    throw new Error('release/dist 디렉터리에 업로드할 아티팩트가 없습니다.');
  }

  return files;
}

async function removeExistingAsset(config, accessToken, assetId) {
  await githubRequest(
    config,
    accessToken,
    `/repos/${config.owner}/${config.repo}/releases/assets/${assetId}`,
    {
      method: 'DELETE',
      expectEmpty: true
    }
  );
}

async function uploadAsset(config, accessToken, release, filePath) {
  const fileName = path.basename(filePath);
  const uploadUrl = new URL(release.upload_url.replace(/\{.*$/, ''));
  uploadUrl.searchParams.set('name', fileName);

  const fileBuffer = await fs.readFile(filePath);
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Length': String(fileBuffer.length),
      'Content-Type': getContentType(fileName),
      'User-Agent': config.userAgent,
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: fileBuffer
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body.message === 'string'
        ? body.message
        : `GitHub 릴리즈 asset 업로드가 실패했습니다. (${response.status})`;
    throw new Error(`${fileName}: ${message}`);
  }

  return body;
}

async function syncReleaseAssets(config, accessToken, release, files) {
  const assetsByName = new Map((release.assets || []).map((asset) => [asset.name, asset]));

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const existing = assetsByName.get(fileName);
    if (existing) {
      console.log(`기존 asset 교체: ${fileName}`);
      await removeExistingAsset(config, accessToken, existing.id);
      await sleep(1_000);
    }

    console.log(`asset 업로드: ${fileName}`);
    await uploadAsset(config, accessToken, release, filePath);
  }
}

async function buildArtifacts(target) {
  const npmCommand = getNpmCommand();
  console.log('');
  console.log(`[${target}] 릴리즈 아티팩트를 빌드합니다.`);
  await runCommand(npmCommand, ['run', `release:dist:${target}`], {
    cwd: desktopRoot
  });
}

async function publishTarget(config, accessToken, target) {
  await buildArtifacts(target);
  const files = await collectArtifacts();
  const release = await ensureRelease(config, accessToken, desktopPackage.version);

  console.log(`[${target}] GitHub Release ${release.tag_name} 에 ${files.length}개 파일을 동기화합니다.`);
  await syncReleaseAssets(config, accessToken, release, files);

  console.log(`[${target}] 완료: ${release.html_url}`);
}

async function main() {
  const target = parseTarget(process.argv[2]);
  const config = assertGitHubOAuthConfig();
  const auth = await loginWithGitHubDeviceFlow();

  console.log(
    `GitHub 인증 확인: ${auth.login ? `@${auth.login}` : '확인된 사용자'} / scope=${auth.scope || config.scope}`
  );

  for (const item of getTargets(target)) {
    await publishTarget(config, auth.accessToken, item);
  }

  console.log('');
  console.log('GitHub Release 업로드가 완료되었습니다.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
