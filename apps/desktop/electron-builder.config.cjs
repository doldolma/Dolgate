module.exports = {
  appId: 'com.doldolma.dolssh',
  productName: 'dolssh',
  electronVersion: '35.0.0',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  directories: {
    output: 'release/dist'
  },
  publish: [
    {
      provider: 'github',
      owner: 'doldolma',
      repo: 'dolssh',
      releaseType: 'release'
    }
  ],
  mac: {
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
    sign: false
  },
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64']
      }
    ]
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: false
  },
  afterSign: 'scripts/notarize.cjs'
};
