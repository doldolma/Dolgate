import 'react-native-gesture-handler';
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import { Buffer } from 'buffer';
/**
 * @format
 */

import { AppRegistry } from 'react-native';
import { ensureAwsRuntimeGlobals } from './src/lib/aws-runtime';
import { name as appName } from './app.json';

if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

ensureAwsRuntimeGlobals();

const App = require('./App').default;

AppRegistry.registerComponent(appName, () => App);
