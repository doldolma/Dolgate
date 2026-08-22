/** @type {import('jest').Config} */
module.exports = {
  // RN 프리셋이 필요하다 — 이 패키지의 컴포넌트가 `processColor` 처럼 플랫폼을 보는 RN API 를
  // 쓰기 때문이다. 프리셋 없이는 RN 내부의 Platform 모듈이 해석되지 않아 그 호출이 던진다.
  preset: 'react-native',
  testMatch: ['<rootDir>/src/**/*.test.{ts,tsx}'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transform: {
    '^.+\\.(ts|tsx|js|jsx)$': 'babel-jest',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native)/)',
  ],
  setupFiles: ['<rootDir>/src/jest.setup.ts'],
  // Suppress react-test-renderer deprecation notice via jest.config
  // (no console monkey-patching needed — the notice is harmless).
  silent: false,
};
