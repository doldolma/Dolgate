const path = require('node:path');

module.exports = {
  dependencies: {
    '@fressh/react-native-uniffi-russh': {
      root: path.resolve(
        __dirname,
        '..',
        '..',
        'packages',
        'fressh-react-native-uniffi-russh',
      ),
    },
  },
};
