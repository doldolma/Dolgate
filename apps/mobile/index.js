import 'react-native-gesture-handler';
import 'react-native-get-random-values';
import { Buffer } from 'buffer';
/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

AppRegistry.registerComponent(appName, () => App);
