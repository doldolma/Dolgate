import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveExtraResources(): string[] {
  const targetPlatform = process.env.DOLSSH_TARGET_PLATFORM;
  const targetArch = process.env.DOLSSH_TARGET_ARCH;
  if (!targetPlatform || !targetArch) {
    return [];
  }

  const binDir = path.resolve(__dirname, `release/resources/${targetPlatform}/${targetArch}/bin`);
  if (!existsSync(binDir)) {
    throw new Error(`Bundled ssh-core resource directory not found: ${binDir}`);
  }

  return [binDir];
}

const config = {
  packagerConfig: {
    asar: true,
    executableName: 'dolssh',
    name: 'dolssh',
    extraResource: resolveExtraResources()
  },
  rebuildConfig: {},
  makers: [],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts'
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts'
        }
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts'
        }
      ]
    })
  ]
};

export default config;
