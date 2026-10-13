import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const pinMacUpdate = require('../../scripts/pin-mac-update-minimum-os.cjs') as {
  MINIMUM_DARWIN_VERSION: string;
  pinLatestMacYml: (ymlPath?: string) => void;
  pinMinimumSystemVersion: (content: string, version?: string) => string;
};

// electron-builder 가 만드는 latest-mac.yml 그대로(v1.9.13).
const LATEST_MAC_YML = `version: 1.9.13
files:
  - url: Dolgate-1.9.13-mac-universal.zip
    sha512: e6Q0fsh0RJC8M2gFf7/I9hEg3EHGp0vR1xvnstmnWgl6DaZs6Q/ulnPQUfbBIYaWlokbq0GhckRcHILIPWtmnw==
    size: 558100544
  - url: Dolgate-1.9.13-mac-universal.dmg
    sha512: ndGMmO3g8K9JJvJJbaY/QXOa36Td48s2AExkE0CcWwPBBZkv6iv+WqtfwJJJS+fRTOD/dGg21hVcHEmur4xOng==
    size: 559112287
path: Dolgate-1.9.13-mac-universal.zip
sha512: e6Q0fsh0RJC8M2gFf7/I9hEg3EHGp0vR1xvnstmnWgl6DaZs6Q/ulnPQUfbBIYaWlokbq0GhckRcHILIPWtmnw==
releaseDate: '2026-10-13T02:16:12.728Z'
`;

describe('pin-mac-update-minimum-os', () => {
  it('uses the Darwin version of macOS 13, not the macOS version', () => {
    // electron-updater 는 os.release()(Darwin) 와 비교한다. "13.0.0" 이면 macOS 12(21.x)가 통과한다.
    expect(pinMacUpdate.MINIMUM_DARWIN_VERSION).toBe('22.0.0');
  });

  it('appends minimumSystemVersion and keeps every existing line', () => {
    expect(pinMacUpdate.pinMinimumSystemVersion(LATEST_MAC_YML)).toBe(
      `${LATEST_MAC_YML}minimumSystemVersion: 22.0.0\n`,
    );
  });

  it('replaces a value that is already there instead of adding a second one', () => {
    const once = pinMacUpdate.pinMinimumSystemVersion(LATEST_MAC_YML, '21.0.0');
    const twice = pinMacUpdate.pinMinimumSystemVersion(once);

    expect(twice).toBe(`${LATEST_MAC_YML}minimumSystemVersion: 22.0.0\n`);
  });

  it('rewrites latest-mac.yml in place and fails when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dolgate-latest-mac-'));
    const ymlPath = join(dir, 'latest-mac.yml');
    await writeFile(ymlPath, LATEST_MAC_YML);

    pinMacUpdate.pinLatestMacYml(ymlPath);

    expect(await readFile(ymlPath, 'utf8')).toBe(`${LATEST_MAC_YML}minimumSystemVersion: 22.0.0\n`);
    expect(() => pinMacUpdate.pinLatestMacYml(join(dir, 'missing.yml'))).toThrow(
      /latest-mac\.yml not found/,
    );
  });
});
