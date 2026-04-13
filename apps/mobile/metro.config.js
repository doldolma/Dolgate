const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('node:path');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const projectNodeModules = path.resolve(projectRoot, 'node_modules');
const rootNodeModules = path.resolve(workspaceRoot, 'node_modules');
const workspacePackages = [
  path.resolve(workspaceRoot, 'packages', 'shared-core'),
  path.resolve(workspaceRoot, 'packages', 'fressh-react-native-uniffi-russh'),
  path.resolve(workspaceRoot, 'packages', 'fressh-react-native-xtermjs-webview'),
  path.resolve(workspaceRoot, 'packages', 'uniffi-bindgen-react-native'),
];

const config = {
  watchFolders: [rootNodeModules, ...workspacePackages],
  resolver: {
    unstable_enableSymlinks: true,
    nodeModulesPaths: [projectNodeModules, rootNodeModules],
    extraNodeModules: {
      react: path.resolve(projectNodeModules, 'react'),
      'react/jsx-runtime': path.resolve(projectNodeModules, 'react/jsx-runtime.js'),
      'react/jsx-dev-runtime': path.resolve(
        projectNodeModules,
        'react/jsx-dev-runtime.js',
      ),
      'react-native': path.resolve(rootNodeModules, 'react-native'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
