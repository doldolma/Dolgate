const path = require('node:path');
const {
  LICENSE_SOURCE,
  METAINFO_SOURCE,
  METAINFO_TARGET,
} = require('./scripts/linux-package-paths.cjs');

module.exports = {
  appId: 'com.doldolma.dolgate',
  productName: 'Dolgate',
  electronVersion: '42.7.0',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  protocols: [
    {
      name: 'Dolgate',
      schemes: ['dolgate']
    }
  ],
  directories: {
    output: 'release/dist'
  },
  publish: [
    {
      provider: 'github',
      owner: 'doldolma',
      repo: 'dolgate',
      releaseType: 'release'
    }
  ],
  mac: {
    icon: path.resolve(__dirname, 'build/icons/dolssh.icns'),
    category: 'public.app-category.developer-tools',
    target: [
      {
        target: 'dmg',
        arch: ['universal']
      },
      {
        target: 'zip',
        arch: ['universal']
      }
    ],
    hardenedRuntime: true,
    // 마이크 권한이 필요해서 기본 권한 파일을 쓰지 않는다(build/entitlements.mac.plist 주석 참고).
    // 헬퍼 프로세스에도 같은 파일을 물린다 — 실제로 장치를 여는 것은 렌더러 쪽 헬퍼다.
    entitlements: path.resolve(__dirname, 'build/entitlements.mac.plist'),
    entitlementsInherit: path.resolve(__dirname, 'build/entitlements.mac.plist'),
    extendInfo: {
      // macOS 권한 대화상자에 그대로 뜨는 문구다. Electron 기본값("This app needs access to
      // the microphone")이 그대로 나가면 무엇에 쓰는지 알 수 없다.
      NSMicrophoneUsageDescription:
        '원격 데스크톱 세션에 마이크 소리를 보내려면 마이크 접근이 필요합니다.'
    },
    gatekeeperAssess: false
  },
  dmg: {
    sign: false,
    icon: path.resolve(__dirname, 'build/icons/dolssh.icns'),
    background: path.resolve(__dirname, 'build/dmg-background.png'),
    iconSize: 144,
    window: {
      width: 960,
      height: 600
    },
    contents: [
      {
        x: 190,
        y: 285,
        type: 'file'
      },
      {
        x: 770,
        y: 285,
        type: 'link',
        path: '/Applications'
      }
    ]
  },
  win: {
    icon: path.resolve(__dirname, 'build/icons/dolssh.ico'),
    target: [
      {
        target: 'nsis',
        arch: ['x64']
      }
    ]
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false
  },
  // deb·rpm 이 같은 after-install 을 쓴다 — chrome-sandbox 를 항상 SUID(4755)로 설치한다.
  //
  // depends 를 주면 electron-builder 의 기본 목록을 "대체"하므로 기본값을 그대로 옮겨 적고
  // 빠진 것만 더한다. 기본 목록은 ALSA 를 빠뜨리는데 Electron 바이너리는 libasound.so.2 를
  // DT_NEEDED 로 하드 링크한다. 데스크톱 환경은 pipewire·pulseaudio 를 통해 ALSA 를 이미
  // 끌고 오므로 대개 드러나지 않지만, 오디오 스택이 없는 최소 설치에서는 설치만 성공하고
  // 실행이 "error while loading shared libraries: libasound.so.2" 로 죽는다. 데비안의
  // chromium 패키지도 libasound2 를 첫 의존성으로 선언한다 — 같은 바이너리에 같은 처방이다.
  deb: {
    afterInstall: path.resolve(__dirname, 'build/linux/after-install.sh'),
    // 상점 페이지용 메타데이터와 저작권 파일을 함께 넣는다.
    //
    // fpm 의 위치 인자(`원본=설치경로`)로 붙인다 — electron-builder 는 이 배열을 fpm 명령의
    // 소스 목록 앞에 그대로 이어 붙인다(app-builder-lib 의 FpmTarget). deb control 에는 라이선스
    // 필드가 없고 상점은 AppStream 을 읽으므로, 이 파일이 없으면 게시자·라이선스·아이콘이 전부
    // 빈칸으로 나온다.
    fpm: [
      `${METAINFO_SOURCE}=${METAINFO_TARGET}`,
      `${LICENSE_SOURCE}=/usr/share/doc/dolgate/copyright`,
    ],
    // libasound2 만 적으면 안 된다. Ubuntu 24.04 에는 실패키지가 없고 t64 전환으로
    // libasound2t64 와 liboss4-salsa-asound2(OSS4 호환 shim)가 둘 다 Provides 하는데,
    // apt 가 후자를 뽑으면 libasound.so.2 가 표준 경로에 깔리지 않아 그대로 실행 실패다.
    // 대안 문법으로 실제 ALSA 를 먼저 집는다 — 24.04 는 t64, 22.04·Debian 12 는 구 이름.
    depends: [
      'libgtk-3-0',
      'libnotify4',
      'libnss3',
      'libxss1',
      'libxtst6',
      'xdg-utils',
      'libatspi2.0-0',
      'libuuid1',
      'libsecret-1-0',
      'libasound2t64 | libasound2'
    ]
  },
  rpm: {
    afterInstall: path.resolve(__dirname, 'build/linux/after-install.sh'),
    // 상점 페이지용 메타데이터와 저작권 파일을 함께 넣는다.
    //
    // fpm 의 위치 인자(`원본=설치경로`)로 붙인다 — electron-builder 는 이 배열을 fpm 명령의
    // 소스 목록 앞에 그대로 이어 붙인다(app-builder-lib 의 FpmTarget). deb control 에는 라이선스
    // 필드가 없고 상점은 AppStream 을 읽으므로, 이 파일이 없으면 게시자·라이선스·아이콘이 전부
    // 빈칸으로 나온다.
    fpm: [
      `${METAINFO_SOURCE}=${METAINFO_TARGET}`,
      `${LICENSE_SOURCE}=/usr/share/doc/dolgate/copyright`,
    ],
    // (A or B) 는 rpm 의 rich dependency 다 — electron-builder 기본값을 그대로 유지한다.
    // libsecret 은 기본 목록에 없다. DT_NEEDED 가 아니라 Electron 이 런타임에 dlopen 하므로
    // 없어도 실행은 되지만 safeStorage 가 평문 폴백으로 떨어진다 — deb 와 같게 맞춘다.
    depends: [
      'gtk3',
      'libnotify',
      'nss',
      'libXScrnSaver',
      '(libXtst or libXtst6)',
      'xdg-utils',
      'at-spi2-core',
      '(libuuid or libuuid1)',
      'libsecret',
      'alsa-lib'
    ]
  },
  linux: {
    icon: path.resolve(__dirname, 'build/icons/dolssh.png'),
    category: 'Development',
    executableName: 'dolgate',
    // deb 의 Section. 없으면 fpm 기본값이 들어가 배포판 도구가 분류하지 못한다.
    packageCategory: 'net',
    // 짧은 줄과 긴 설명을 나눈다. 하나만 주면 control 의 Description 첫 줄과 본문이 같은 문장이
    // 되어 상점 페이지에 같은 글이 두 번 나온다(실제로 그랬다).
    synopsis: 'SSH, SFTP, and remote desktop client',
    description:
      'Dolgate connects to servers over SSH with jump hosts, one-time-code prompts, and ' +
      'host key trust asked inside the connection. It also browses files over SFTP, opens ' +
      'local port forwards, attaches to container and AWS EC2 shells, and shows remote ' +
      'desktops over VNC and RDP.',
    desktop: {
      entry: {
        GenericName: 'SSH Client',
        Keywords: 'ssh;sftp;terminal;port forwarding;vnc;rdp;',
      },
    },
    // 실제 타겟/arch는 scripts/build-linux-installers.cjs 가 CLI로 지정한다.
    //
    // AppImage 는 배포하지 않는다. 다운로드한 파일에는 실행 비트가 없어 사용자가 chmod 를
    // 해야 하고, 읽기 전용 FUSE 마운트라 chrome-sandbox 에 setuid 를 걸 수 없어 샌드박스도
    // 못 쓴다. 설치형(deb·rpm)은 둘 다 해결된다.
    target: [
      {
        target: 'deb'
      },
      {
        target: 'rpm'
      }
    ]
  }
  // afterSign 훅은 두지 않는다. 릴리스는 이미 서명·공증을 마친 .app 을 --prepackaged 로
  // 넘기는데, 그 경우 doPack 이 곧바로 return 해서 서명 단계 자체가 없고 훅도 발화하지
  // 않는다. 서명·공증은 electron-builder 앞단의 scripts/sign-notarize-mac.cjs 가 한다.
};
