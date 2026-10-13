const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

// Electron 44 부터 앱은 macOS 13 이상에서만 돈다. electron-updater 는 latest-mac.yml 의
// minimumSystemVersion 을 os.release() 와 semver 로 비교하므로, 값은 macOS 버전이 아니라 Darwin
// 커널 버전이어야 한다(macOS 13 Ventura = Darwin 22, macOS 12 는 21.x). electron-builder 는 이
// 필드를 쓰지 않아(mac.minimumSystemVersion 은 Info.plist 에만 들어간다) 여기서 넣는다 — 빠지면
// macOS 12 사용자가 실행되지 않는 버전을 자동 업데이트로 받는다.
const MINIMUM_DARWIN_VERSION = '22.0.0';

const defaultYmlPath = path.resolve(__dirname, '..', 'release', 'dist', 'latest-mac.yml');

function pinMinimumSystemVersion(content, version = MINIMUM_DARWIN_VERSION) {
  const lines = content
    .split('\n')
    .filter((line) => !line.startsWith('minimumSystemVersion:'));
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return `${lines.join('\n')}\nminimumSystemVersion: ${version}\n`;
}

function pinLatestMacYml(ymlPath = defaultYmlPath) {
  if (!existsSync(ymlPath)) {
    throw new Error(`latest-mac.yml not found: ${ymlPath}`);
  }
  writeFileSync(ymlPath, pinMinimumSystemVersion(readFileSync(ymlPath, 'utf8')));
}

if (require.main === module) {
  pinLatestMacYml();
  console.log(`latest-mac.yml pinned to minimumSystemVersion ${MINIMUM_DARWIN_VERSION}`);
}

module.exports = {
  MINIMUM_DARWIN_VERSION,
  pinLatestMacYml,
  pinMinimumSystemVersion
};
