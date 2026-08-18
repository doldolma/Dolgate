import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../../electron-builder.config.cjs') as {
  deb: { fpm: string[] };
  rpm: { fpm: string[] };
};
const {
  LICENSE_SOURCE,
  METAINFO_SOURCE,
  METAINFO_TARGET,
} = require('../../scripts/linux-package-paths.cjs') as {
  LICENSE_SOURCE: string;
  METAINFO_SOURCE: string;
  METAINFO_TARGET: string;
};
const { validateConfiguration } = require('app-builder-lib/out/util/config/config') as {
  validateConfiguration: (
    config: unknown,
    debugLogger: { add: () => void },
  ) => Promise<void>;
};

describe('electron-builder config', () => {
  it('matches the electron-builder schema before release packaging', async () => {
    await expect(
      validateConfiguration(config, { add: () => undefined }),
    ).resolves.toBeUndefined();
  });

  it('uses the shared Linux package paths without exporting them as config keys', () => {
    expect(config).not.toHaveProperty('METAINFO_SOURCE');
    expect(config).not.toHaveProperty('METAINFO_TARGET');
    expect(config.deb.fpm).toEqual([
      `${METAINFO_SOURCE}=${METAINFO_TARGET}`,
      `${LICENSE_SOURCE}=/usr/share/doc/dolgate/copyright`,
    ]);
    expect(config.rpm.fpm).toEqual(config.deb.fpm);
  });
});
