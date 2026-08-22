// Enable React act() environment for test-renderer
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// React Native requires __DEV__ to be defined
(globalThis as Record<string, unknown>).__DEV__ = true;
