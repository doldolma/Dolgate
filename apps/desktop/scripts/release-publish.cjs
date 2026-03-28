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

function runCommandCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnOptions = {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    };

    const child =
      process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [command, ...args].map(quoteWindowsCommandArg).join(' ')], spawnOptions)
        : spawn(command, args, spawnOptions);

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const details = stderr.trim() || stdout.trim();
      reject(
        new Error(
          `${command} ${args.join(' ')} 명령이 종료 코드 ${code}로 실패했습니다.${details ? `\n${details}` : ''}`
        )
      );
    });
  });
}

async function getHeadSha() {
  const result = await runCommandCapture('git', ['rev-parse', 'HEAD'], {
    cwd: desktopRoot
  });
  return result.stdout.trim();
}

async function getLocalTagTargetSha(tagName) {
  const result = await runCommandCapture('git', ['rev-list', '-n', '1', tagName], {
    cwd: desktopRoot
  }).catch(() => null);
  return result?.stdout.trim() || null;
}

async function getRemoteTagTargetSha(tagName) {
  const result = await runCommandCapture(
    'git',
    ['ls-remote', '--tags', 'origin', `refs/tags/${tagName}`, `refs/tags/${tagName}^{}`],
    {
      cwd: desktopRoot
    }
  ).catch(() => null);

  const output = result?.stdout.trim();
  if (!output) {
    return null;
  }

  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const dereferenced = lines.find((line) => line.endsWith(`refs/tags/${tagName}^{}`));
  const direct = lines.find((line) => line.endsWith(`refs/tags/${tagName}`));
  const selected = dereferenced || direct;

  return selected ? selected.split(/\s+/u)[0] : null;
}

async function ensureCleanReleaseState() {
  const result = await runCommandCapture('git', ['status', '--porcelain'], {
    cwd: desktopRoot
  });

  if (result.stdout.trim()) {
    throw new Error('릴리즈 전에 작업 트리가 깨끗해야 합니다. 변경 사항을 커밋하거나 정리한 뒤 다시 시도해 주세요.');
  }
}

async function ensureReleaseTag(version) {
  const tagName = `v${version}`;
  const headSha = await getHeadSha();
  const localTagSha = await getLocalTagTargetSha(tagName);
  const remoteTagSha = await getRemoteTagTargetSha(tagName);

  if (localTagSha && localTagSha !== headSha) {
    throw new Error(
      `로컬 태그 ${tagName} 가 현재 HEAD가 아닌 ${localTagSha.slice(0, 7)} 을(를) 가리키고 있습니다. 릴리즈를 중단합니다.`
    );
  }

  if (remoteTagSha && remoteTagSha !== headSha) {
    throw new Error(
      `원격 태그 ${tagName} 가 현재 HEAD가 아닌 ${remoteTagSha.slice(0, 7)} 을(를) 가리키고 있습니다. 릴리즈를 중단합니다.`
    );
  }

  if (!localTagSha && !remoteTagSha) {
    console.log(`릴리즈 태그 생성: ${tagName}`);
    await runCommand('git', ['tag', '-a', tagName, '-m', tagName], {
      cwd: desktopRoot
    });
  }

  if (!remoteTagSha) {
    console.log(`릴리즈 태그 푸시: ${tagName}`);
    await runCommand('git', ['push', 'origin', tagName], {
      cwd: desktopRoot
    });
  }

  return tagName;
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
  await ensureReleaseTag(desktopPackage.version);
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

  await ensureCleanReleaseState();

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
