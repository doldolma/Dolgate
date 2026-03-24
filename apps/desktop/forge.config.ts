import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetPlatform = process.env.DOLSSH_TARGET_PLATFORM ?? process.platform;

function resolveExtraResources(): string[] {
  const extraResources = [path.resolve(__dirname, 'config'), path.resolve(__dirname, 'assets')];
  const targetPlatform = process.env.DOLSSH_TARGET_PLATFORM;
  const targetArch = process.env.DOLSSH_TARGET_ARCH;
  if (!targetPlatform || !targetArch) {
    return extraResources;
  }

  const binDir = path.resolve(__dirname, `release/resources/${targetPlatform}/${targetArch}/bin`);
  if (!existsSync(binDir)) {
    throw new Error(`Bundled ssh-core resource directory not found: ${binDir}`);
  }

  extraResources.push(binDir);
  return extraResources;
}

function resolveAppIcon(): string {
  if (targetPlatform === 'win32') {
    return path.resolve(__dirname, 'build/icons/dolssh.ico');
  }

  if (targetPlatform === 'darwin') {
    return path.resolve(__dirname, 'build/icons/dolssh.icns');
  }

  return path.resolve(__dirname, 'build/icons/dolssh.png');
}

const config = {
  packagerConfig: {
    asar: true,
    prune: false,
    executableName: 'dolssh',
    name: 'dolssh',
    protocols: [
      {
        name: 'dolssh',
        schemes: ['dolssh']
      }
    ],
    icon: resolveAppIcon(),
    ignore: (file: string) => {
      if (!file) {
        return false;
      }

      if (targetPlatform !== 'win32' && file.startsWith('/node_modules/node-pty')) {
        return true;
      }

      // Vite 산출물과 패키지 런타임 의존성만 남기고 나머지는 패키징에서 제외한다.
      return !(file.startsWith('/.vite') || file.startsWith('/node_modules'));
    },
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
