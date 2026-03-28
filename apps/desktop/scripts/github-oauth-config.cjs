const path = require('node:path');

const desktopPackage = require(path.join(__dirname, '..', 'package.json'));

const UNCONFIGURED_GITHUB_OAUTH_CLIENT_ID = 'SET_GITHUB_OAUTH_CLIENT_ID';
const DEFAULT_GITHUB_OAUTH_CLIENT_ID = 'Ov23liDesKUde9q8rcNu';

function getGitHubOAuthConfig() {
  return {
    clientId: (process.env.DOLSSH_GITHUB_OAUTH_CLIENT_ID || DEFAULT_GITHUB_OAUTH_CLIENT_ID).trim(),
    scope: (process.env.DOLSSH_GITHUB_OAUTH_SCOPE || 'public_repo').trim(),
    owner: 'doldolma',
    repo: 'dolgate',
    userAgent: `dolgate-release-cli/${desktopPackage.version}`
  };
}

function assertGitHubOAuthConfig() {
  const config = getGitHubOAuthConfig();
  if (!config.clientId || config.clientId === UNCONFIGURED_GITHUB_OAUTH_CLIENT_ID) {
    throw new Error(
      [
        'GitHub OAuth App client ID가 설정되지 않았습니다.',
        `한 번만 ${path.join('apps', 'desktop', 'scripts', 'github-oauth-config.cjs')} 파일의 DEFAULT_GITHUB_OAUTH_CLIENT_ID 값을 실제 client ID로 바꾸거나,`,
        '임시로 DOLSSH_GITHUB_OAUTH_CLIENT_ID 환경변수를 사용하세요.',
        '또한 GitHub OAuth App 설정에서 Device Flow를 활성화해야 합니다.'
      ].join(' ')
    );
  }
  return config;
}

module.exports = {
  DEFAULT_GITHUB_OAUTH_CLIENT_ID,
  getGitHubOAuthConfig,
  assertGitHubOAuthConfig
};
