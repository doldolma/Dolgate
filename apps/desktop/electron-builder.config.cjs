const path = require('node:path');

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
  deb: {
    afterInstall: path.resolve(__dirname, 'build/linux/after-install.sh')
  },
  rpm: {
    afterInstall: path.resolve(__dirname, 'build/linux/after-install.sh')
  },
  linux: {
    icon: path.resolve(__dirname, 'build/icons/dolssh.png'),
    category: 'Development',
    executableName: 'dolgate',
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
