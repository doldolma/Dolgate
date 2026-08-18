const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');

// electron-builder 설정과 패키지 검증이 같은 경로를 보게 한 곳에서 관리한다.
// 이 값들을 electron-builder 설정 객체 자체에 붙이면 알 수 없는 설정 키로 해석돼
// 플랫폼과 무관하게 모든 데스크톱 릴리스 빌드가 스키마 검증에서 실패한다.
module.exports = {
  METAINFO_SOURCE: path.resolve(
    desktopRoot,
    'build/linux/com.doldolma.dolgate.metainfo.xml',
  ),
  METAINFO_TARGET: '/usr/share/metainfo/com.doldolma.dolgate.metainfo.xml',
  LICENSE_SOURCE: path.resolve(desktopRoot, '../../LICENSE'),
};
