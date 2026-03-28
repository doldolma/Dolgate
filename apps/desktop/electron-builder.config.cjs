const path = require('node:path');

module.exports = {
  appId: 'com.doldolma.dolgate',
  productName: 'Dolgate',
  electronVersion: '35.0.0',
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
  afterSign: 'scripts/notarize.cjs'
};
