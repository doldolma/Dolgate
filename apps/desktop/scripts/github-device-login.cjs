const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { assertGitHubOAuthConfig } = require('./github-oauth-config.cjs');

function getOpenBrowserCommand(url) {
  if (process.platform === 'darwin') {
    return { command: 'open', args: [url] };
  }

  if (process.platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', url] };
  }

  return { command: 'xdg-open', args: [url] };
}

function tryOpenBrowser(url) {
  const { command, args } = getOpenBrowserCommand(url);

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function postFormJson(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params)
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      typeof body.error_description === 'string'
        ? body.error_description
        : typeof body.error === 'string'
          ? body.error
          : `GitHub OAuth 요청이 실패했습니다. (${response.status})`;
    throw new Error(message);
  }

  return body;
}

async function fetchAuthenticatedUser(accessToken, userAgent) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': userAgent,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body.message === 'string'
        ? body.message
        : `GitHub 사용자 확인에 실패했습니다. (${response.status})`;
    throw new Error(message);
  }

  return body;
}

async function requestDeviceCode(config) {
  return postFormJson('https://github.com/login/device/code', {
    client_id: config.clientId,
    scope: config.scope
  });
}

async function pollForAccessToken(config, deviceCode, intervalSeconds, expiresInSeconds) {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let waitMs = intervalSeconds * 1000;

  while (Date.now() < deadline) {
    await sleep(waitMs);

    const response = await postFormJson('https://github.com/login/oauth/access_token', {
      client_id: config.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    }).catch((error) => {
      throw error;
    });

    if (typeof response.access_token === 'string' && response.access_token.length > 0) {
      return response;
    }

    switch (response.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        waitMs += 5000;
        continue;
      case 'access_denied':
        throw new Error('사용자가 GitHub 로그인/승인을 취소했습니다.');
      case 'expired_token':
      case 'token_expired':
        throw new Error('GitHub device code가 만료되었습니다. publish 명령을 다시 실행하세요.');
      case 'device_flow_disabled':
        throw new Error('GitHub OAuth App에서 Device Flow가 비활성화되어 있습니다.');
      default:
        throw new Error(
          typeof response.error === 'string'
            ? `GitHub OAuth 토큰 발급이 실패했습니다: ${response.error}`
            : 'GitHub OAuth 토큰 발급이 실패했습니다.'
        );
    }
  }

  throw new Error('GitHub 로그인 대기 시간이 초과되었습니다. 다시 시도하세요.');
}

async function loginWithGitHubDeviceFlow() {
  const config = assertGitHubOAuthConfig();
  const device = await requestDeviceCode(config);
  const verificationUri = device.verification_uri || 'https://github.com/login/device';
  const browserOpened = tryOpenBrowser(verificationUri);

  console.log('');
  console.log('GitHub 릴리즈 업로드를 위해 브라우저 로그인을 시작합니다.');
  console.log(`- 열기 URL: ${verificationUri}`);
  console.log(`- 입력 코드: ${device.user_code}`);
  if (!browserOpened) {
    console.log('- 브라우저를 자동으로 열지 못했습니다. 위 URL을 직접 열어 코드를 입력해 주세요.');
  }
  console.log('');

  const tokenResponse = await pollForAccessToken(
    config,
    device.device_code,
    Number(device.interval) || 5,
    Number(device.expires_in) || 900
  );

  const user = await fetchAuthenticatedUser(tokenResponse.access_token, config.userAgent);

  return {
    accessToken: tokenResponse.access_token,
    scope: tokenResponse.scope || config.scope,
    login: typeof user.login === 'string' ? user.login : null
  };
}

if (require.main === module) {
  loginWithGitHubDeviceFlow()
    .then((result) => {
      console.log(`GitHub 로그인 완료: ${result.login ? `@${result.login}` : '확인된 사용자'}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

module.exports = {
  loginWithGitHubDeviceFlow
};
