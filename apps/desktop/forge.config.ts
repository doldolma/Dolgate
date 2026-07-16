import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetPlatform = process.env.DOLSSH_TARGET_PLATFORM ?? process.platform;
const hasExplicitPackageTarget =
  Boolean(process.env.DOLSSH_TARGET_PLATFORM) ||
  Boolean(process.env.DOLSSH_TARGET_ARCH);

function resolveDefaultTargetArch(platform: string): string {
  if (platform === 'darwin') {
    return 'universal';
  }

  if (platform === 'win32') {
    return 'x64';
  }

  return process.arch;
}

const targetArch =
  process.env.DOLSSH_TARGET_ARCH ?? resolveDefaultTargetArch(targetPlatform);

// package/make/publish 는 리소스 누락 시 ssh-core 없는 앱이 만들어지므로 실패시키고,
// start(dev) 는 번들 리소스를 쓰지 않으므로 경고만 남긴다.
// forge CLI 는 서브커맨드를 electron-forge-package.js 같은 별도 프로세스로 실행하므로
// argv 의 단어와 스크립트 파일명을 함께 본다.
const forgePackagingCommands = new Set(['package', 'make', 'publish']);
const isPackagingCommand = process.argv.some((arg) => {
  const token = path.basename(arg);
  return (
    forgePackagingCommands.has(token) ||
    /^electron-forge-(package|make|publish)\b/.test(token)
  );
});

function resolvePrepareHint(missingPath: string): string {
  if (missingPath.endsWith(`${path.sep}bin`)) {
    return 'npm run prepare:ssh-core:dev';
  }

  if (targetPlatform === 'darwin') {
    return 'npm run release:prepare:codex:mac';
  }

  if (targetPlatform === 'win32') {
    return 'npm run release:prepare:codex:win';
  }

  return 'npm run release:prepare:codex:linux';
}

function resolveExtraResources(): string[] {
  const extraResources = [path.resolve(__dirname, 'config'), path.resolve(__dirname, 'assets')];

  const binDir = path.resolve(__dirname, `release/resources/${targetPlatform}/${targetArch}/bin`);
  const codexDir = path.resolve(__dirname, `release/resources/${targetPlatform}/${targetArch}/codex-cli`);
  const missingReleaseResources = [binDir, codexDir].filter((resourcePath) => !existsSync(resourcePath));
  if (missingReleaseResources.length > 0) {
    const detail = missingReleaseResources
      .map((resourcePath) => `${resourcePath} (fix: ${resolvePrepareHint(resourcePath)})`)
      .join(', ');
    if (hasExplicitPackageTarget || isPackagingCommand) {
      throw new Error(`Bundled release resource directory not found: ${detail}`);
    }
    console.warn(`[forge] Bundled release resource directory not found, packaging would omit ssh-core/codex-cli: ${detail}`);
    return extraResources;
  }

  extraResources.push(binDir);
  extraResources.push(codexDir);
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
    executableName: 'dolgate',
    name: 'dolgate',
    protocols: [
      {
        name: 'Dolgate',
        schemes: ['dolgate']
      }
    ],
    icon: resolveAppIcon(),
    osxUniversal: {
      x64ArchFiles: '**/codex-cli/vendor/**/*'
    },
    ignore: (file: string) => {
      if (!file) {
        return false;
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
